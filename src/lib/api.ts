/**
 * Central fetch wrapper that intercepts 429 (Too Many Requests) responses,
 * reads the Retry-After header, and schedules an automatic retry.
 *
 * Consumers call `apiFetch` instead of raw `fetch`. When a 429 is received:
 *  - The global RateLimitContext is notified so the banner renders a countdown.
 *  - The request is queued and retried automatically after the delay.
 *  - Only one pending rate-limit state is tracked at a time; concurrent 429s
 *    do not duplicate the banner.
 */

type RateLimitListener = (retryAt: number | null) => void;

const listeners = new Set<RateLimitListener>();
let currentRetryAt: number | null = null;

/** Subscribe to rate-limit state changes (used by RateLimitContext). */
export function subscribeRateLimit(fn: RateLimitListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Read the current retryAt timestamp (ms epoch), or null if not rate-limited. */
export function getCurrentRateLimitRetryAt(): number | null {
  return currentRetryAt;
}

function notify(retryAt: number | null) {
  currentRetryAt = retryAt;
  listeners.forEach((fn) => fn(retryAt));
}

/**
 * Parse the Retry-After header value (seconds or HTTP-date) into milliseconds
 * from now. Falls back to 60 s if the header is absent or unparseable.
 */
function parseRetryAfter(header: string | null): number {
  if (!header) return 60_000;
  const seconds = Number(header);
  if (!Number.isNaN(seconds) && seconds > 0) return seconds * 1_000;
  const date = new Date(header);
  if (!Number.isNaN(date.getTime())) {
    return Math.max(0, date.getTime() - Date.now());
  }
  return 60_000;
}

/**
 * `apiFetch` is a drop-in replacement for `fetch` that adds transparent
 * 429-retry with countdown notification.
 *
 * - Retries the request **once** after the Retry-After delay.
 * - Resolves the original Promise as if the first call had succeeded.
 * - Multiple concurrent 429s share one countdown; the banner stays single.
 */
export async function apiFetch(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  const response = await fetch(input, init);

  if (response.status !== 429) return response;

  const delayMs = parseRetryAfter(response.headers.get("Retry-After"));
  const retryAt = Date.now() + delayMs;

  // Only update state if no countdown is already running or this one is later.
  if (currentRetryAt === null || retryAt > currentRetryAt) {
    notify(retryAt);
  }

  // Wait for the retry window, then re-issue the request.
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));

  // Clear rate-limit state after retry fires.
  notify(null);

  return fetch(input, init);
}

/* -------------------------------------------------------------------------- */
/*                          Co-signer API helpers                             */
/* -------------------------------------------------------------------------- */

/** Approval state of a single co-signer. */
export type CoSignerStatus = "pending" | "approved";

/** A single required co-signer on an invoice. */
export interface CoSigner {
  /** Stellar address of the co-signer. */
  address: string;
  /** Current approval state. */
  status: CoSignerStatus;
  /** Optional signature payload submitted on approval. */
  signature?: string;
  /** ISO timestamp of when the co-signer approved, if applicable. */
  approvedAt?: string;
}

/** Shape returned by `fetchCoSigners`. */
export interface CoSignerState {
  cosigners: CoSigner[];
  cosignerThreshold: number;
}

/** Classified error thrown by the co-signer helpers. */
export class CoSignerApiError extends Error {
  /** HTTP status code, or 0 for network/parse failures. */
  readonly status: number;
  /** Machine-readable error classification. */
  readonly code:
    | "network"
    | "unauthorized"
    | "forbidden"
    | "not_found"
    | "conflict"
    | "rate_limited"
    | "server"
    | "parse"
    | "unknown";

  constructor(
    message: string,
    status: number,
    code: CoSignerApiError["code"]
  ) {
    super(message);
    this.name = "CoSignerApiError";
    this.status = status;
    this.code = code;
  }
}

function classifyStatus(status: number): CoSignerApiError["code"] {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server";
  return "unknown";
}

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const body = await response.json();
    if (body && typeof body.error === "string") return body.error;
    if (body && typeof body.message === "string") return body.message;
  } catch {
    /* ignore parse failures */
  }
  return `Request failed with status ${response.status}`;
}

function normalizeCoSigner(raw: unknown): CoSigner {
  const record = (raw ?? {}) as Record<string, unknown>;
  const status = record.status === "approved" ? "approved" : "pending";
  return {
    address: typeof record.address === "string" ? record.address : "",
    status,
    signature:
      typeof record.signature === "string" ? record.signature : undefined,
    approvedAt:
      typeof record.approvedAt === "string" ? record.approvedAt : undefined,
  };
}

/**
 * Fetch the co-signer list and threshold for an invoice.
 *
 * Reads `splitMeta.cosigners` and `splitMeta.cosignerThreshold` from
 * `GET /api/invoices/:id`.
 */
export async function fetchCoSigners(
  invoiceId: string
): Promise<CoSignerState> {
  let response: Response;
  try {
    response = await apiFetch(`/api/invoices/${encodeURIComponent(invoiceId)}`);
  } catch (err) {
    throw new CoSignerApiError(
      err instanceof Error ? err.message : "Network request failed",
      0,
      "network"
    );
  }

  if (!response.ok) {
    throw new CoSignerApiError(
      await readErrorMessage(response),
      response.status,
      classifyStatus(response.status)
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new CoSignerApiError(
      "Failed to parse invoice response",
      response.status,
      "parse"
    );
  }

  const splitMeta =
    body && typeof body === "object"
      ? ((body as Record<string, unknown>).splitMeta as
          | Record<string, unknown>
          | undefined)
      : undefined;

  const rawCosigners = Array.isArray(splitMeta?.cosigners)
    ? (splitMeta!.cosigners as unknown[])
    : [];
  const threshold =
    typeof splitMeta?.cosignerThreshold === "number"
      ? splitMeta.cosignerThreshold
      : 0;

  return {
    cosigners: rawCosigners.map(normalizeCoSigner),
    cosignerThreshold: threshold,
  };
}

/**
 * Submit an approval for a co-signer by patching the invoice's `splitMeta`.
 *
 * Sends `PATCH /api/invoices/:id` with the updated co-signer entry. The
 * caller is responsible for passing the full current list via `cosigners`
 * when the backend requires a full replacement; otherwise only the approving
 * address is sent.
 */
export async function submitCoSignerApproval(
  invoiceId: string,
  address: string,
  signature?: string,
  cosigners?: CoSigner[]
): Promise<CoSignerState> {
  const approvedEntry: CoSigner = {
    address,
    status: "approved",
    signature,
    approvedAt: new Date().toISOString(),
  };

  const nextCosigners = cosigners
    ? cosigners.map((c) => (c.address === address ? approvedEntry : c))
    : [approvedEntry];

  let response: Response;
  try {
    response = await apiFetch(
      `/api/invoices/${encodeURIComponent(invoiceId)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          splitMeta: { cosigners: nextCosigners },
        }),
      }
    );
  } catch (err) {
    throw new CoSignerApiError(
      err instanceof Error ? err.message : "Network request failed",
      0,
      "network"
    );
  }

  if (!response.ok) {
    throw new CoSignerApiError(
      await readErrorMessage(response),
      response.status,
      classifyStatus(response.status)
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new CoSignerApiError(
      "Failed to parse approval response",
      response.status,
      "parse"
    );
  }

  const splitMeta =
    body && typeof body === "object"
      ? ((body as Record<string, unknown>).splitMeta as
          | Record<string, unknown>
          | undefined)
      : undefined;

  const rawCosigners = Array.isArray(splitMeta?.cosigners)
    ? (splitMeta!.cosigners as unknown[])
    : nextCosigners;
  const threshold =
    typeof splitMeta?.cosignerThreshold === "number"
      ? splitMeta.cosignerThreshold
      : 0;

  return {
    cosigners: rawCosigners.map(normalizeCoSigner),
    cosignerThreshold: threshold,
  };
}
