"use client";

/**
 * Centralized fetch wrapper for mutating API calls. Injects the
 * `X-CSRF-Token` header (see src/lib/csrf.ts / src/lib/middleware/csrfMiddleware.ts)
 * on POST/PUT/PATCH/DELETE requests, refreshing the cached token before it
 * expires and transparently retrying once if a request is rejected with 403
 * because the token expired mid-flight.
 */

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// Refresh a little early so a request that starts right before expiry
// doesn't race the server-side clock.
const REFRESH_SKEW_MS = 60 * 1000;

let cachedToken: string | null = null;
let cachedExpiresAt = 0;
let inflightFetch: Promise<string> | null = null;

async function fetchFreshToken(): Promise<string> {
  const response = await fetch("/api/csrf");
  if (!response.ok) {
    throw new Error("Failed to fetch CSRF token");
  }
  const data = await response.json();
  cachedToken = data.token;
  cachedExpiresAt = data.expiresAt;
  return data.token;
}

export async function getCsrfToken(forceRefresh = false): Promise<string> {
  if (!forceRefresh && cachedToken && Date.now() < cachedExpiresAt - REFRESH_SKEW_MS) {
    return cachedToken;
  }
  if (!forceRefresh && inflightFetch) {
    return inflightFetch;
  }

  inflightFetch = fetchFreshToken().finally(() => {
    inflightFetch = null;
  });
  return inflightFetch;
}

export function getCachedCsrfExpiry(): number {
  return cachedExpiresAt;
}

/**
 * fetch() wrapper that attaches a CSRF token to mutating requests and
 * retries once, with a freshly-fetched token, if the server rejects the
 * first attempt with 403.
 */
export async function apiFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  if (!MUTATING_METHODS.has(method)) {
    return fetch(input, init);
  }

  const attempt = async (token: string) => {
    const headers = new Headers(init.headers);
    headers.set("X-CSRF-Token", token);
    return fetch(input, { ...init, headers });
  };

  const token = await getCsrfToken();
  const response = await attempt(token);
  if (response.status !== 403) {
    return response;
  }

  const freshToken = await getCsrfToken(true);
  return attempt(freshToken);
}

/**
 * Helper for JSON POSTs through apiFetch. Throws on non-2xx responses so
 * callers can surface errors in the UI.
 */
async function postJson<T = unknown>(url: string, body: unknown): Promise<T> {
  const response = await apiFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`Request to ${url} failed with status ${response.status}`);
  }
  return response.json() as Promise<T>;
}

// --- Milestones (#876) ---

export interface MilestoneInput {
  invoiceId: string;
  title: string;
  description?: string;
  amount: number;
  dueDate?: string;
  conditions?: string[];
}

export interface MilestoneEvidenceInput {
  milestoneId: string;
  fileName: string;
  contentType: string;
  /** Base64-encoded file contents. */
  data: string;
  notes?: string;
}

export interface MilestoneApprovalInput {
  milestoneId: string;
  approverId: string;
  approved: boolean;
  comment?: string;
}

export interface MilestoneReleaseInput {
  milestoneId: string;
  amount?: number;
}

export function postMilestone<T = unknown>(input: MilestoneInput): Promise<T> {
  return postJson<T>("/api/milestones", input);
}

export function postMilestoneEvidence<T = unknown>(input: MilestoneEvidenceInput): Promise<T> {
  return postJson<T>(`/api/milestones/${encodeURIComponent(input.milestoneId)}/evidence`, input);
}

export function postMilestoneApproval<T = unknown>(input: MilestoneApprovalInput): Promise<T> {
  return postJson<T>(`/api/milestones/${encodeURIComponent(input.milestoneId)}/approvals`, input);
}

export function postMilestoneRelease<T = unknown>(input: MilestoneReleaseInput): Promise<T> {
  return postJson<T>(`/api/milestones/${encodeURIComponent(input.milestoneId)}/release`, input);
}

// --- Disputes (#877) ---

export interface DisputeInput {
  invoiceId: string;
  reason: string;
  details?: string;
  amount?: number;
}

export interface DisputeEvidenceInput {
  disputeId: string;
  fileName: string;
  contentType: string;
  /** Base64-encoded file contents. */
  data: string;
  notes?: string;
}

export interface DisputeArbitratorInput {
  disputeId: string;
  arbitratorId: string;
}

export interface DisputeResolveInput {
  disputeId: string;
  resolution: string;
  awardedAmount?: number;
  notes?: string;
}

export interface DisputeEnforceInput {
  disputeId: string;
}

export function postDispute<T = unknown>(input: DisputeInput): Promise<T> {
  return postJson<T>("/api/disputes", input);
}

export function postDisputeEvidence<T = unknown>(input: DisputeEvidenceInput): Promise<T> {
  return postJson<T>(`/api/disputes/${encodeURIComponent(input.disputeId)}/evidence`, input);
}

export function postDisputeArbitrator<T = unknown>(input: DisputeArbitratorInput): Promise<T> {
  return postJson<T>(`/api/disputes/${encodeURIComponent(input.disputeId)}/arbitrator`, input);
}

export function postDisputeResolve<T = unknown>(input: DisputeResolveInput): Promise<T> {
  return postJson<T>(`/api/disputes/${encodeURIComponent(input.disputeId)}/resolve`, input);
}

export function postDisputeEnforce<T = unknown>(input: DisputeEnforceInput): Promise<T> {
  return postJson<T>(`/api/disputes/${encodeURIComponent(input.disputeId)}/enforce`, input);
}
