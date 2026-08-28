import { useEffect, useRef, useState, type FormEvent } from "react";
import type { TestSessionAction, TestSessionEvent, TestSessionEventType, TracewriteClient } from "./types";

/**
 * Resolves a human label for a focused control without ever reading its
 * value — the privacy floor tracewrite is built around: a tester filling in
 * a real form field must never have that value logged, only which field it
 * was.
 */
function resolveFieldLabel(el: HTMLElement): string | null {
  const tag = el.tagName.toLowerCase();
  if (!["input", "textarea", "select", "button"].includes(tag)) return null;
  const ariaLabel = el.getAttribute("aria-label");
  if (ariaLabel) return ariaLabel;
  if (el.id) {
    const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (label?.textContent) return label.textContent.trim();
  }
  const name = el.getAttribute("name");
  if (name) return name;
  const placeholder = el.getAttribute("placeholder");
  if (placeholder) return placeholder;
  return `a ${tag}`;
}

export interface TestingOverlayProps {
  /** Talks to the host's backend; see types.ts's TracewriteClient. */
  client: TracewriteClient;
  /**
   * Whether the overlay should render and capture at all — the host decides
   * this from its own flag/auth state (e.g. a hidden ?testing=1 flag AND a
   * signed-in account). The overlay itself has no opinion on auth.
   */
  active: boolean;
  /**
   * The current path, from whatever router the host uses — e.g.
   * `useLocation().pathname` (react-router) or `usePathname()`
   * (`next/navigation`). The overlay has no router opinion of its own so it
   * mounts under any host, including Next.js App Router.
   */
  pathname: string;
}

/**
 * A UAT capture overlay that wraps the real app. Auto-logs navigation and
 * focused-field *context* and lets the tester attach freeform comments to
 * that context; the backend's AI review loop replies inline, either a
 * clarifying question or a proposed follow-up action the tester can confirm
 * in their next reply.
 */
export function TestingOverlay({ client, active, pathname }: TestingOverlayProps) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [timeline, setTimeline] = useState<TestSessionEvent[]>([]);
  const [actions, setActions] = useState<TestSessionAction[]>([]);
  const [context, setContext] = useState<{ pagePath: string; fieldLabel: string | null }>({
    pagePath: pathname,
    fieldLabel: null,
  });
  const [commentText, setCommentText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  // Defaults open — this is a conversational overlay; a tester who just typed
  // a comment needs to see the AI's reply land without an extra click.
  const [collapsed, setCollapsed] = useState(false);

  const sessionPromiseRef = useRef<Promise<string> | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const lastPathRef = useRef<string | null>(null);
  const lastFieldRef = useRef<string | null>(null);

  function ensureSession(): Promise<string> {
    if (sessionId) return Promise.resolve(sessionId);
    if (!sessionPromiseRef.current) {
      sessionPromiseRef.current = client.startSession().then((r) => {
        setSessionId(r.session.id);
        return r.session.id;
      });
    }
    return sessionPromiseRef.current;
  }

  async function record(eventType: TestSessionEventType, pagePath: string, fieldLabel?: string, note?: string) {
    try {
      const sid = await ensureSession();
      const result = await client.logEvent(sid, { eventType, pagePath, fieldLabel, note });
      setTimeline((t) => [...t, result.event, ...(result.aiReply ? [result.aiReply] : [])]);
      if (result.action) {
        const action = result.action;
        setActions((prev) => {
          const idx = prev.findIndex((a) => a.id === action.id);
          if (idx === -1) return [...prev, action];
          const next = [...prev];
          next[idx] = action;
          return next;
        });
      }
    } catch {
      // Best-effort — the overlay must never break the app it's testing.
    }
  }

  useEffect(() => {
    if (!active) return;
    if (lastPathRef.current === pathname) return;
    lastPathRef.current = pathname;
    lastFieldRef.current = null;
    setContext({ pagePath: pathname, fieldLabel: null });
    void record("navigation", pathname);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, pathname]);

  useEffect(() => {
    if (!active) return;
    function handleFocusIn(e: FocusEvent) {
      const el = e.target;
      if (!(el instanceof HTMLElement) || el.closest("[data-testing-overlay]")) return;
      const label = resolveFieldLabel(el);
      if (!label || lastFieldRef.current === label) return;
      lastFieldRef.current = label;
      setContext((c) => ({ ...c, fieldLabel: label }));
      void record("focus", pathname, label);
    }
    document.addEventListener("focusin", handleFocusIn);
    return () => document.removeEventListener("focusin", handleFocusIn);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, pathname]);

  async function handleSubmitComment(e: FormEvent) {
    e.preventDefault();
    const text = commentText.trim();
    if (!text || submitting) return;
    setSubmitting(true);
    setCommentText("");
    await record("comment", pathname, context.fieldLabel ?? undefined, text);
    setSubmitting(false);
  }

  async function handleEndSession() {
    if (sessionId) {
      await client.endSession(sessionId).catch(() => {});
    }
    setSessionId(null);
    sessionPromiseRef.current = null;
    setTimeline([]);
    setActions([]);
  }

  // Reserve the bar's own height at the bottom of the page so it never covers page content.
  // Docking it to the bottom edge stops it sitting on top of a form's submit button, but on its
  // own it would still hide the last rows of a list. Measured rather than hardcoded because the
  // bar's height changes when the timeline is collapsed or grows.
  useEffect(() => {
    const el = rootRef.current;
    if (!active || !el) return;
    const body = document.body;
    const previous = body.style.paddingBottom;
    const apply = () => {
      body.style.paddingBottom = `${el.getBoundingClientRect().height}px`;
    };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(el);
    return () => {
      observer.disconnect();
      body.style.paddingBottom = previous;
    };
  }, [active, collapsed]);

  if (!active) return null;

  const actionByReplyEventId = new Map(actions.map((a) => [a.event_id, a]));

  return (
    <div className="testing-overlay no-print" data-testing-overlay ref={rootRef}>
      <div className="testing-overlay-header">
        <strong>Testing Mode</strong>
        <button type="button" className="secondary" onClick={() => setCollapsed((c) => !c)}>
          {collapsed ? "Show timeline" : "Hide timeline"}
        </button>
        <button type="button" className="secondary" onClick={handleEndSession}>
          {sessionId ? "End session" : "New session"}
        </button>
      </div>

      {!collapsed && (
        <div className="testing-overlay-timeline">
          {timeline.length === 0 && <div className="testing-overlay-empty">No activity logged yet.</div>}
          {timeline.map((ev) => {
            const action = actionByReplyEventId.get(ev.id);
            return (
              <div key={ev.id} className={`testing-overlay-row testing-overlay-row-${ev.event_type}`}>
                {ev.event_type === "navigation" && <span>Navigated to {ev.page_path}</span>}
                {ev.event_type === "focus" && (
                  <span>
                    Focused "{ev.field_label}" on {ev.page_path}
                  </span>
                )}
                {ev.event_type === "comment" && <span>{ev.note}</span>}
                {ev.event_type === "ai_reply" && (
                  <span>
                    <em>AI:</em> {ev.note}
                    {action && (
                      <span className={`testing-overlay-badge testing-overlay-badge-${action.status}`}>
                        {action.status}
                      </span>
                    )}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}

      <form className="testing-overlay-comment-box" onSubmit={handleSubmitComment}>
        <div className="testing-overlay-context">
          Commenting on: {context.pagePath}
          {context.fieldLabel ? ` / ${context.fieldLabel}` : ""}
        </div>
        <div className="testing-overlay-input-row">
          <input
            type="text"
            value={commentText}
            onChange={(e) => setCommentText(e.target.value)}
            placeholder="What are you seeing?"
            disabled={submitting}
          />
          <button type="submit" disabled={submitting || commentText.trim().length === 0}>
            Send
          </button>
        </div>
      </form>
    </div>
  );
}
