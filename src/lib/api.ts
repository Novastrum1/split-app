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
/*  Milestones & Disputes API client                                          */
/* -------------------------------------------------------------------------- */

/** Error thrown by the typed API client when a request fails. */
export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details?: unknown;

  constructor(
    message: string,
    status: number,
    code?: string,
    details?: unknown
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** Read the CSRF token from the cookie set by the backend. */
function readCsrfToken(): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

interface ApiClientOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
}

/**
 * Typed JSON client built on top of `apiFetch`. Mutations automatically
 * include the CSRF token and JSON content type. Non-2xx responses are
 * converted into `ApiError` instances.
 */
async function apiClient<T>(
  path: string,
  options: ApiClientOptions = {}
): Promise<T> {
  const { method = "GET", body, signal } = options;
  const headers: Record<string, string> = { Accept: "application/json" };

  if (body !== undefined) headers["Content-Type"] = "application/json";

  if (method !== "GET") {
    const csrf = readCsrfToken();
    if (csrf) headers["X-CSRF-Token"] = csrf;
  }

  let response: Response;
  try {
    response = await apiFetch(path, {
      method,
      headers,
      signal,
      credentials: "same-origin",
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw new ApiError(
      err instanceof Error ? err.message : "Network request failed",
      0
    );
  }

  if (!response.ok) {
    let payload: { message?: string; code?: string; details?: unknown } = {};
    try {
      payload = await response.json();
    } catch {
      /* ignore non-JSON error bodies */
    }
    throw new ApiError(
      payload.message ?? `Request failed with status ${response.status}`,
      response.status,
      payload.code,
      payload.details
    );
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/* ----------------------------- Milestones -------------------------------- */

export type MilestoneStatus =
  | "pending"
  | "evidence_submitted"
  | "approved"
  | "released"
  | "rejected";

export interface MilestoneCondition {
  id: string;
  description: string;
  type: "deliverable" | "approval" | "evidence";
  satisfied: boolean;
  approvedBy?: string;
  approvedAt?: string;
}

export interface MilestoneEvidence {
  id: string;
  milestoneId: string;
  fileName: string;
  url: string;
  uploadedBy: string;
  uploadedAt: string;
  verified: boolean;
}

export interface Milestone {
  id: string;
  invoiceId: string;
  title: string;
  description?: string;
  amount: number;
  currency: string;
  status: MilestoneStatus;
  conditions: MilestoneCondition[];
  evidence: MilestoneEvidence[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateMilestoneInput {
  invoiceId: string;
  title: string;
  description?: string;
  amount: number;
  currency: string;
  conditions: Array<Pick<MilestoneCondition, "description" | "type">>;
}

export interface SubmitEvidenceInput {
  fileName: string;
  url: string;
  notes?: string;
}

export interface ApproveConditionInput {
  conditionId: string;
  approved: boolean;
  comment?: string;
}

/** Create a new milestone with its release conditions. */
export function createMilestone(
  input: CreateMilestoneInput,
  signal?: AbortSignal
): Promise<Milestone> {
  return apiClient<Milestone>("/api/milestones", {
    method: "POST",
    body: input,
    signal,
  });
}

/** Attach evidence/documentation to a milestone. */
export function submitMilestoneEvidence(
  milestoneId: string,
  input: SubmitEvidenceInput,
  signal?: AbortSignal
): Promise<MilestoneEvidence> {
  return apiClient<MilestoneEvidence>(
    `/api/milestones/${encodeURIComponent(milestoneId)}/evidence`,
    { method: "POST", body: input, signal }
  );
}

/** Approve or reject a single milestone condition. */
export function approveMilestoneCondition(
  milestoneId: string,
  input: ApproveConditionInput,
  signal?: AbortSignal
): Promise<Milestone> {
  return apiClient<Milestone>(
    `/api/milestones/${encodeURIComponent(milestoneId)}/conditions/${encodeURIComponent(
      input.conditionId
    )}/approve`,
    { method: "POST", body: input, signal }
  );
}

/** Release the milestone funds once all conditions are satisfied. */
export function releaseMilestone(
  milestoneId: string,
  signal?: AbortSignal
): Promise<Milestone> {
  return apiClient<Milestone>(
    `/api/milestones/${encodeURIComponent(milestoneId)}/release`,
    { method: "POST", signal }
  );
}

/* ------------------------------ Disputes --------------------------------- */

export type DisputeStatus =
  | "open"
  | "evidence"
  | "arbitration"
  | "resolved"
  | "enforced";

export interface DisputeEvidence {
  id: string;
  disputeId: string;
  submittedBy: string;
  fileName: string;
  url: string;
  notes?: string;
  submittedAt: string;
}

export interface DisputeTimelineEntry {
  id: string;
  disputeId: string;
  action: string;
  actor: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export interface Dispute {
  id: string;
  invoiceId: string;
  openedBy: string;
  reason: string;
  status: DisputeStatus;
  arbitratorId?: string;
  evidence: DisputeEvidence[];
  timeline: DisputeTimelineEntry[];
  resolution?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateDisputeInput {
  invoiceId: string;
  reason: string;
  description?: string;
}

export interface SubmitDisputeEvidenceInput {
  fileName: string;
  url: string;
  notes?: string;
}

export interface AssignArbitratorInput {
  arbitratorId: string;
}

export interface ResolveDisputeInput {
  resolution: string;
  favorParty: "payer" | "recipient" | "split";
  splitPercentage?: number;
}

/** Open a new dispute for an invoice. */
export function createDispute(
  input: CreateDisputeInput,
  signal?: AbortSignal
): Promise<Dispute> {
  return apiClient<Dispute>("/api/disputes", {
    method: "POST",
    body: input,
    signal,
  });
}

/** Submit evidence from either party to a dispute. */
export function submitDisputeEvidence(
  disputeId: string,
  input: SubmitDisputeEvidenceInput,
  signal?: AbortSignal
): Promise<DisputeEvidence> {
  return apiClient<DisputeEvidence>(
    `/api/disputes/${encodeURIComponent(disputeId)}/evidence`,
    { method: "POST", body: input, signal }
  );
}

/** Assign an arbitrator to a dispute. */
export function assignDisputeArbitrator(
  disputeId: string,
  input: AssignArbitratorInput,
  signal?: AbortSignal
): Promise<Dispute> {
  return apiClient<Dispute>(
    `/api/disputes/${encodeURIComponent(disputeId)}/arbitrator`,
    { method: "POST", body: input, signal }
  );
}

/** Record the arbitrator's decision on a dispute. */
export function resolveDispute(
  disputeId: string,
  input: ResolveDisputeInput,
  signal?: AbortSignal
): Promise<Dispute> {
  return apiClient<Dispute>(
    `/api/disputes/${encodeURIComponent(disputeId)}/resolve`,
    { method: "POST", body: input, signal }
  );
}

/** Enforce the recorded resolution (e.g. move funds accordingly). */
export function enforceDisputeResolution(
  disputeId: string,
  signal?: AbortSignal
): Promise<Dispute> {
  return apiClient<Dispute>(
    `/api/disputes/${encodeURIComponent(disputeId)}/enforce`,
    { method: "POST", signal }
  );
}
