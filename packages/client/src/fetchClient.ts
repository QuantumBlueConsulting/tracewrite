import type { LogTestSessionEventInput, TracewriteClient } from "./types";

export interface FetchTracewriteClientOptions {
  /** e.g. "/api/test-sessions" or "https://api.example.com/test-sessions" — no trailing slash. */
  baseUrl: string;
  /** Called once per request; return headers to merge in, e.g. an Authorization bearer token. */
  getHeaders?: () => Record<string, string> | Promise<Record<string, string>>;
}

/**
 * A ready TracewriteClient over fetch, matching the five REST routes both
 * tracewrite-server adapters (Fastify, Express) expose at the same paths.
 * Covers the common case; a host with a different HTTP/auth layer should
 * implement TracewriteClient directly instead — see the README.
 */
export function createFetchTracewriteClient({ baseUrl, getHeaders }: FetchTracewriteClientOptions): TracewriteClient {
  async function request(path: string, init?: RequestInit) {
    const extraHeaders = (await getHeaders?.()) ?? {};
    const res = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...extraHeaders, ...init?.headers },
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`tracewrite request failed: ${res.status}${detail ? ` ${detail}` : ""}`);
    }
    return res.json();
  }

  return {
    startSession: (label) => request("", { method: "POST", body: JSON.stringify({ label }) }),
    endSession: (sessionId) => request(`/${sessionId}`, { method: "PATCH" }),
    logEvent: (sessionId, input: LogTestSessionEventInput) =>
      request(`/${sessionId}/events`, { method: "POST", body: JSON.stringify(input) }),
    listSessions: () => request(""),
    listEvents: (sessionId) => request(`/${sessionId}/events`),
    listActions: (sessionId) => request(`/${sessionId}/actions`),
  };
}
