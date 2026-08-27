// Type declarations for tracewrite-server.
//
// This package ships plain ESM with no build step, so these are hand-written rather than emitted.
// They exist for one concrete reason: without them a consumer importing an export that does not
// exist compiles cleanly and throws at runtime in a deployed environment. That happened — a host
// imported `createTestSessionExpressRouter` against a published version that predated it, and
// nothing caught it until someone went looking.
//
// Keep in step with index.mjs. If an export is added, renamed or removed there, change it here in
// the same commit.

import type { Pool } from "pg";

// ---------------------------------------------------------------------------------------
// Framework handles are structural on purpose.
//
// `express` and `fastify` are OPTIONAL peers — a Fastify host has no express installed, and vice
// versa. A top-level `import type { Router } from "express"` in this file would fail to resolve
// for exactly half of all consumers. These shapes are structurally compatible with what each
// framework expects, so `app.use(path, router)` and `app.register(plugin)` both accept them.
// ---------------------------------------------------------------------------------------

/** Structurally an Express `RequestHandler`. */
export type TracewriteRequestHandler = (
  req: unknown,
  res: unknown,
  next: (err?: unknown) => void,
) => void;

/** Structurally an Express `Router` — callable as middleware, mountable with `app.use`. */
export type TracewriteExpressRouter = TracewriteRequestHandler & Record<string, unknown>;

/** Structurally a Fastify plugin. */
export type TracewriteFastifyPlugin = (app: unknown) => Promise<void>;

// ---------------------------------------------------------------------------------------
// Data shapes — the rows the API returns, matching the schema package's migration.
// ---------------------------------------------------------------------------------------

export interface TestSessionRow {
  id: string;
  account_id: string;
  label: string | null;
  started_at: string;
  ended_at: string | null;
}

export type TestSessionEventType = "navigation" | "focus" | "comment" | "ai_reply";

export interface TestSessionEventRow {
  id: string;
  session_id: string;
  account_id: string;
  event_type: TestSessionEventType;
  page_path: string;
  field_label: string | null;
  note: string | null;
  created_at: string;
}

export type TestSessionActionStatus = "open" | "accepted" | "dismissed";

export interface TestSessionActionRow {
  id: string;
  session_id: string;
  event_id: string;
  description: string;
  status: TestSessionActionStatus;
  created_at: string;
  updated_at: string;
}

/** The AI review step only ever runs for 'comment' events, so both extras are optional. */
export interface LogEventResult {
  event: TestSessionEventRow;
  aiReply?: TestSessionEventRow;
  action?: TestSessionActionRow;
}

// ---------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------

/** Thrown by the session API. `code` is what `statusByCode` maps to an HTTP status. */
export declare class TestSessionError extends Error {
  constructor(code: TestSessionErrorCode, message: string);
  code: TestSessionErrorCode;
}

export type TestSessionErrorCode = "invalid_input" | "not_found";

/**
 * Thrown inside the AI review step. Callers do not normally see it: a missing key or a failed
 * call never blocks a tester's comment from saving, it is caught and swallowed.
 */
export declare class TestSessionAiError extends Error {
  constructor(code: TestSessionAiErrorCode, message: string);
  code: TestSessionAiErrorCode;
}

export type TestSessionAiErrorCode = "not_configured" | "request_failed";

// ---------------------------------------------------------------------------------------
// The host-agnostic core
// ---------------------------------------------------------------------------------------

export interface CreateTestSessionsApiOptions {
  /** Any function returning a `pg` Pool. Called per query, so a lazily-built pool is fine. */
  getPool: () => Pool;
}

/**
 * Session and timeline logic with no HTTP framework attached. Every method takes the caller's
 * `accountId` and scopes its queries to it — that is where isolation is enforced, since the tables
 * ship without row-level security.
 */
export interface TestSessionsApi {
  startSession(input: { accountId: string; label?: string | null }): Promise<TestSessionRow>;
  endSession(input: { accountId: string; sessionId: string }): Promise<TestSessionRow>;
  logEvent(input: {
    accountId: string;
    sessionId: string;
    eventType: TestSessionEventType;
    pagePath: string;
    fieldLabel?: string | null;
    note?: string | null;
  }): Promise<LogEventResult>;
  listSessions(input: { accountId: string }): Promise<TestSessionRow[]>;
  listEvents(input: { accountId: string; sessionId: string }): Promise<TestSessionEventRow[]>;
  listActions(input: { accountId: string; sessionId: string }): Promise<TestSessionActionRow[]>;
}

export declare function createTestSessionsApi(
  options: CreateTestSessionsApiOptions,
): TestSessionsApi;

// ---------------------------------------------------------------------------------------
// HTTP adapters — same routes, two frameworks
// ---------------------------------------------------------------------------------------

/** Maps a `TestSessionError.code` to an HTTP status. Unmapped codes fall back to 400. */
export type StatusByCode = Partial<Record<TestSessionErrorCode, number>>;

export interface CreateTestSessionRoutesOptions extends CreateTestSessionsApiOptions {
  statusByCode?: StatusByCode;
}

/**
 * Fastify plugin. The host app must already decorate `authenticate` as an `onRequest` hook, and it
 * must populate `request.user.sub` with the caller's account id.
 */
export declare function createTestSessionRoutes(
  options: CreateTestSessionRoutesOptions,
): TracewriteFastifyPlugin;

export interface CreateTestSessionExpressRouterOptions extends CreateTestSessionRoutesOptions {
  /**
   * Express middleware run ahead of every route. Must populate `req.user.sub` with the caller's
   * account id, and is where a host applies its own authentication and any role gate.
   */
  authenticate: TracewriteRequestHandler;
}

/**
 * Express router, for Express hosts and Nest apps on `@nestjs/platform-express`. Requires JSON
 * body parsing already applied ahead of it — Nest's Express platform does this by default.
 *
 * Not for `@nestjs/platform-fastify`; use `createTestSessionRoutes` there.
 */
export declare function createTestSessionExpressRouter(
  options: CreateTestSessionExpressRouterOptions,
): TracewriteExpressRouter;

// ---------------------------------------------------------------------------------------
// Testing
// ---------------------------------------------------------------------------------------

/**
 * Replaces the Anthropic client at the module boundary so a suite can run with no API key and no
 * network. Pass `null` to restore the real one.
 */
export declare function setTestSessionAiClientForTesting(fakeClient: unknown): void;
