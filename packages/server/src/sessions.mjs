// tracewrite's session/timeline logic. A session is one tester's pass
// through the product; its timeline is an append-only log of auto-captured
// context (navigation/focus — page + field *label*, never a value)
// interleaved with the tester's own comments and the AI reviewer's replies.
//
// Host-agnostic: everything here takes its Postgres pool through
// `createTestSessionsApi({ getPool })` rather than assuming any particular
// db module shape. The host must have run this package's migration
// (packages/schema/migrations) first: `test_session`, `test_session_event`,
// `test_session_action`, no RLS, account/tenant-scoped only by an
// `account_id` column the host's own auth supplies — this package has no
// opinion on what an "account" is beyond that uuid.
import { proposeReply, classifyConfirmation, TestSessionAiError } from "./ai.mjs";

export class TestSessionError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // "invalid_input" | "not_found"
  }
}

const EVENT_TYPES = ["navigation", "focus", "comment", "ai_reply"];
const RECENT_EVENTS_FOR_REVIEW = 8;

/**
 * @param {{getPool: () => import("pg").Pool}} deps
 */
export function createTestSessionsApi({ getPool }) {
  async function startSession({ accountId, label }) {
    const { rows } = await getPool().query(
      `INSERT INTO test_session (account_id, label) VALUES ($1, $2)
       RETURNING id, account_id, label, started_at, ended_at`,
      [accountId, label ?? null]
    );
    return rows[0];
  }

  async function endSession({ accountId, sessionId }) {
    const { rows } = await getPool().query(
      `UPDATE test_session SET ended_at = now() WHERE id = $1 AND account_id = $2
       RETURNING id, account_id, label, started_at, ended_at`,
      [sessionId, accountId]
    );
    if (rows.length === 0) {
      // Same generic not-found whether the session never existed or belongs
      // to someone else — don't let this endpoint confirm other accounts' ids.
      throw new TestSessionError("not_found", `No session with id ${sessionId}`);
    }
    return rows[0];
  }

  async function assertSessionOwnership(accountId, sessionId) {
    const { rows } = await getPool().query(`SELECT id FROM test_session WHERE id = $1 AND account_id = $2`, [
      sessionId,
      accountId,
    ]);
    if (rows.length === 0) {
      throw new TestSessionError("not_found", `No session with id ${sessionId}`);
    }
  }

  async function getOpenAction(sessionId) {
    const { rows } = await getPool().query(
      `SELECT id, session_id, event_id, description, status, created_at, updated_at
       FROM test_session_action WHERE session_id = $1 AND status = 'open'
       ORDER BY created_at DESC LIMIT 1`,
      [sessionId]
    );
    return rows[0] ?? null;
  }

  async function updateActionStatus({ accountId, actionId, status }) {
    // test_session_action has no account_id of its own — ownership is
    // checked through the session it belongs to, same account-scoping
    // guarantee as every other write here.
    const { rows } = await getPool().query(
      `UPDATE test_session_action a SET status = $1, updated_at = now()
       FROM test_session s
       WHERE a.id = $2 AND a.session_id = s.id AND s.account_id = $3
       RETURNING a.id, a.session_id, a.event_id, a.description, a.status, a.created_at, a.updated_at`,
      [status, actionId, accountId]
    );
    return rows[0];
  }

  async function getRecentEvents(sessionId, limit) {
    const { rows } = await getPool().query(
      `SELECT event_type, page_path, field_label, note
       FROM test_session_event WHERE session_id = $1
       ORDER BY created_at DESC LIMIT $2`,
      [sessionId, limit]
    );
    return rows.reverse(); // oldest first, so the AI reads it as a timeline
  }

  /**
   * @param {{sessionId: string, accountId: string, eventType: string, pagePath: string, fieldLabel?: string | null, note?: string | null}} args
   */
  async function insertEvent({ sessionId, accountId, eventType, pagePath, fieldLabel, note }) {
    const { rows } = await getPool().query(
      `INSERT INTO test_session_event (session_id, account_id, event_type, page_path, field_label, note)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, session_id, account_id, event_type, page_path, field_label, note, created_at`,
      [sessionId, accountId, eventType, pagePath, fieldLabel ?? null, note ?? null]
    );
    return rows[0];
  }

  /**
   * The AI review step, run after a 'comment' event is saved. Best-effort:
   * any TestSessionAiError (missing key, rate limit, network) is swallowed
   * here so an AI hiccup never fails the comment that already persisted —
   * callers just get back `{}` alongside the event. A real bug (e.g. a DB
   * error inserting the ai_reply row) still propagates.
   */
  async function runReviewStep({ accountId, sessionId, comment, pagePath }) {
    try {
      const pendingAction = await getOpenAction(sessionId);
      if (pendingAction) {
        const { verdict } = await classifyConfirmation({
          actionDescription: pendingAction.description,
          replyText: comment,
        });
        if (verdict === "confirmed" || verdict === "declined") {
          const action = await updateActionStatus({
            accountId,
            actionId: pendingAction.id,
            status: verdict === "confirmed" ? "accepted" : "dismissed",
          });
          // A "yeah, that would work" doesn't need its own clarifying
          // question — the confirmation itself is the response.
          return { action };
        }
        // unclear — fall through to a normal reply below rather than
        // looping on the same open action forever.
      }

      const recentEvents = await getRecentEvents(sessionId, RECENT_EVENTS_FOR_REVIEW);
      const { kind, message } = await proposeReply({
        recentEvents: recentEvents.map((e) => ({
          eventType: e.event_type,
          pagePath: e.page_path,
          fieldLabel: e.field_label,
          note: e.note,
        })),
        comment,
      });

      const aiReplyEvent = await insertEvent({
        sessionId,
        accountId,
        eventType: "ai_reply",
        pagePath,
        note: message,
      });

      if (kind !== "proposed_action") {
        return { aiReply: aiReplyEvent };
      }

      const { rows: actionRows } = await getPool().query(
        `INSERT INTO test_session_action (session_id, event_id, description)
         VALUES ($1, $2, $3)
         RETURNING id, session_id, event_id, description, status, created_at, updated_at`,
        [sessionId, aiReplyEvent.id, message]
      );
      return { aiReply: aiReplyEvent, action: actionRows[0] };
    } catch (err) {
      if (err instanceof TestSessionAiError) return {};
      throw err;
    }
  }

  async function logEvent({ accountId, sessionId, eventType, pagePath, fieldLabel, note }) {
    if (!EVENT_TYPES.includes(eventType)) {
      throw new TestSessionError("invalid_input", `eventType must be one of ${EVENT_TYPES.join(", ")}.`);
    }
    if (typeof pagePath !== "string" || pagePath.trim().length === 0) {
      throw new TestSessionError("invalid_input", "pagePath is required.");
    }
    const requiresNote = eventType === "comment" || eventType === "ai_reply";
    if (requiresNote && (typeof note !== "string" || note.trim().length === 0)) {
      throw new TestSessionError("invalid_input", "note is required for comment/ai_reply events.");
    }
    await assertSessionOwnership(accountId, sessionId);

    const event = await insertEvent({
      sessionId,
      accountId,
      eventType,
      pagePath: pagePath.trim(),
      fieldLabel,
      note: note ? note.trim() : null,
    });

    if (eventType !== "comment") {
      return { event };
    }

    const review = await runReviewStep({ accountId, sessionId, comment: event.note, pagePath: event.page_path });
    return { event, ...review };
  }

  async function listSessions({ accountId }) {
    const { rows } = await getPool().query(
      `SELECT id, account_id, label, started_at, ended_at FROM test_session
       WHERE account_id = $1 ORDER BY started_at DESC`,
      [accountId]
    );
    return rows;
  }

  async function listEvents({ accountId, sessionId }) {
    await assertSessionOwnership(accountId, sessionId);
    const { rows } = await getPool().query(
      `SELECT id, session_id, account_id, event_type, page_path, field_label, note, created_at
       FROM test_session_event WHERE session_id = $1 ORDER BY created_at ASC`,
      [sessionId]
    );
    return rows;
  }

  async function listActions({ accountId, sessionId }) {
    await assertSessionOwnership(accountId, sessionId);
    const { rows } = await getPool().query(
      `SELECT id, session_id, event_id, description, status, created_at, updated_at
       FROM test_session_action WHERE session_id = $1 ORDER BY created_at ASC`,
      [sessionId]
    );
    return rows;
  }

  return { startSession, endSession, logEvent, listSessions, listEvents, listActions };
}
