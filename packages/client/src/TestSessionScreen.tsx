import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { TestSession, TestSessionAction, TestSessionEvent, TracewriteClient } from "./types";

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : "Something went wrong.";
}

function ActionStatusPill({ status }: { status: string }) {
  return <span className={`pill ${status}`}>{status}</span>;
}

function TimelineRow({ event, action }: { event: TestSessionEvent; action?: TestSessionAction }) {
  return (
    <div className={`testing-overlay-row testing-overlay-row-${event.event_type}`}>
      <span className="muted" style={{ fontSize: "0.75rem" }}>
        {new Date(event.created_at).toLocaleTimeString()}
      </span>{" "}
      {event.event_type === "navigation" && <span>Navigated to {event.page_path}</span>}
      {event.event_type === "focus" && (
        <span>
          Focused "{event.field_label}" on {event.page_path}
        </span>
      )}
      {event.event_type === "comment" && <span>{event.note}</span>}
      {event.event_type === "ai_reply" && (
        <span>
          <em>AI:</em> {event.note}
          {action && <ActionStatusPill status={action.status} />}
        </span>
      )}
    </div>
  );
}

/** The session list — mounted by the host at whatever path it chooses. */
function SessionListView({ client }: { client: TracewriteClient }) {
  const [sessions, setSessions] = useState<TestSession[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { sessions } = await client.listSessions();
      setSessions(sessions);
      setError(null);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="page">
      <h1>Testing sessions</h1>

      {error && <div className="error">{error}</div>}
      {loading && <p className="muted">Loading…</p>}

      {!loading && sessions.length === 0 && (
        <div className="panel">
          <p>No testing sessions yet.</p>
          <p className="muted">
            Visit the app with <code>?testing=1</code> to start one.
          </p>
        </div>
      )}

      {sessions.length > 0 && (
        <div className="panel">
          <table>
            <thead>
              <tr>
                <th>Session</th>
                <th>Started</th>
                <th>Ended</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.id}>
                  <td>
                    <Link to={`/test-sessions/${s.id}`}>{s.label ?? s.id}</Link>
                  </td>
                  <td>{new Date(s.started_at).toLocaleString()}</td>
                  <td>
                    {s.ended_at ? new Date(s.ended_at).toLocaleString() : <span className="muted">in progress</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/**
 * One session's full timeline. The punch list (from `listActions`) is the
 * "determine if there are actions needed" view: a reviewer can scan
 * proposed/confirmed/declined follow-ups without re-reading the whole
 * conversation, then drop into the timeline below for the full context
 * behind any one of them.
 */
function SessionDetailView({ client, sessionId }: { client: TracewriteClient; sessionId: string }) {
  const [events, setEvents] = useState<TestSessionEvent[]>([]);
  const [actions, setActions] = useState<TestSessionAction[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [eventsResult, actionsResult] = await Promise.all([
        client.listEvents(sessionId),
        client.listActions(sessionId),
      ]);
      setEvents(eventsResult.events);
      setActions(actionsResult.actions);
      setError(null);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoading(false);
    }
  }, [client, sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  const actionByReplyEventId = new Map(actions.map((a) => [a.event_id, a]));

  return (
    <div className="page">
      <div className="crumbs">
        <Link to="/test-sessions">Testing sessions</Link> / Timeline
      </div>
      <h1>Session timeline</h1>

      {error && <div className="error">{error}</div>}
      {loading && <p className="muted">Loading…</p>}

      {!loading && actions.length > 0 && (
        <div className="panel">
          <h2>Punch list</h2>
          <table>
            <thead>
              <tr>
                <th>Action</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {actions.map((a) => (
                <tr key={a.id}>
                  <td>{a.description}</td>
                  <td>
                    <ActionStatusPill status={a.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!loading && events.length === 0 && (
        <div className="panel">
          <p>No activity logged in this session.</p>
        </div>
      )}

      {!loading && events.length > 0 && (
        <div className="panel">
          <h2>Timeline</h2>
          {events.map((ev) => (
            <TimelineRow key={ev.id} event={ev} action={actionByReplyEventId.get(ev.id)} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The review UI over `client`'s session list/timeline/punch-list. No chrome
 * of its own (no nav/top bar) — the host wraps this in whatever page frame
 * it already uses, the same way it wraps any other route's screen.
 */
export function TestSessionScreen({ client }: { client: TracewriteClient }) {
  const { id } = useParams();
  return id ? <SessionDetailView client={client} sessionId={id} /> : <SessionListView client={client} />;
}
