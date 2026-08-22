// tracewrite's data shapes and the client contract the components in this
// package depend on. TestingOverlay and TestSessionScreen import only from
// this file, never from a host's own auth/HTTP modules — a host wires
// tracewrite up by implementing TracewriteClient over its own stack.
export interface TestSession {
  id: string;
  account_id: string;
  label: string | null;
  started_at: string;
  ended_at: string | null;
}

export type TestSessionEventType = "navigation" | "focus" | "comment" | "ai_reply";

export interface TestSessionEvent {
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

export interface TestSessionAction {
  id: string;
  session_id: string;
  event_id: string;
  description: string;
  status: TestSessionActionStatus;
  created_at: string;
  updated_at: string;
}

/** The AI review step only ever runs for 'comment' events. */
export interface LogTestSessionEventResult {
  event: TestSessionEvent;
  aiReply?: TestSessionEvent;
  action?: TestSessionAction;
}

export interface LogTestSessionEventInput {
  eventType: TestSessionEventType;
  pagePath: string;
  fieldLabel?: string;
  note?: string;
}

/**
 * Everything TestingOverlay and TestSessionScreen need from the host, in
 * terms of what to call rather than how — the host owns auth, base URL, and
 * error shape. A typical implementation wraps @quantumblueconsulting/tracewrite-server's
 * five routes with the host's own fetch/auth layer; see the README.
 */
export interface TracewriteClient {
  startSession(label?: string): Promise<{ session: TestSession }>;
  endSession(sessionId: string): Promise<{ session: TestSession }>;
  logEvent(sessionId: string, input: LogTestSessionEventInput): Promise<LogTestSessionEventResult>;
  listSessions(): Promise<{ sessions: TestSession[] }>;
  listEvents(sessionId: string): Promise<{ events: TestSessionEvent[] }>;
  listActions(sessionId: string): Promise<{ actions: TestSessionAction[] }>;
}
