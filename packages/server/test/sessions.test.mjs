// Standalone harness: a minimal Fastify app wired the way this package
// expects any host to wire it (fastifyJwt for auth, createTestSessionRoutes
// mounted at /test-sessions), against a real Postgres that's had this
// package's migration applied. The Anthropic client is mocked at the module
// boundary (ai.mjs's setTestSessionAiClientForTesting) — same "real code,
// fake external client" approach as everywhere else — so these tests never
// hit the network.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import fastifyJwt from "@fastify/jwt";
import pg from "pg";
import { createTestSessionRoutes } from "../src/plugin.mjs";
import { setTestSessionAiClientForTesting } from "../src/ai.mjs";

const STATUS_BY_CODE = { invalid_input: 400, not_found: 404 };

let pool;
let app;
let tokenA;
let tokenB;

let nextReply = { kind: "acknowledgement", message: "Got it." };
let nextVerdict = "unclear";
let shouldThrow = false;
let calls = [];

const fakeClient = {
  messages: {
    create: async ({ system }) => {
      if (shouldThrow) throw new Error("simulated network failure");
      const isConfirmation = system.includes("Classify whether");
      calls.push(isConfirmation ? "confirmation" : "reply");
      const payload = isConfirmation ? { verdict: nextVerdict } : nextReply;
      return { content: [{ type: "text", text: JSON.stringify(payload) }] };
    },
  },
};

function getPool() {
  return pool;
}

before(async () => {
  setTestSessionAiClientForTesting(fakeClient);

  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query(`
    CREATE TABLE IF NOT EXISTS test_session (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      account_id  uuid NOT NULL,
      label       text,
      started_at  timestamptz NOT NULL DEFAULT now(),
      ended_at    timestamptz
    );
    CREATE TABLE IF NOT EXISTS test_session_event (
      id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      session_id   uuid NOT NULL REFERENCES test_session (id),
      account_id   uuid NOT NULL,
      event_type   text NOT NULL CHECK (event_type IN ('navigation', 'focus', 'comment', 'ai_reply')),
      page_path    text NOT NULL,
      field_label  text,
      note         text,
      created_at   timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT test_session_event_note_required
        CHECK (event_type NOT IN ('comment', 'ai_reply') OR note IS NOT NULL)
    );
    CREATE TABLE IF NOT EXISTS test_session_action (
      id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      session_id   uuid NOT NULL REFERENCES test_session (id),
      event_id     uuid NOT NULL REFERENCES test_session_event (id),
      description  text NOT NULL,
      status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'dismissed')),
      created_at   timestamptz NOT NULL DEFAULT now(),
      updated_at   timestamptz NOT NULL DEFAULT now()
    );
  `);

  app = Fastify();
  app.register(fastifyJwt, { secret: "test-only-secret" });
  app.decorate("authenticate", async (request, reply) => {
    try {
      await request.jwtVerify();
    } catch {
      reply.code(401).send({ error: "unauthenticated" });
    }
  });
  app.register(createTestSessionRoutes({ getPool, statusByCode: STATUS_BY_CODE }), { prefix: "/test-sessions" });
  await app.ready();

  tokenA = app.jwt.sign({ sub: randomUUID() });
  tokenB = app.jwt.sign({ sub: randomUUID() });
});

after(async () => {
  await pool.query(`DROP TABLE IF EXISTS test_session_action, test_session_event, test_session;`);
  await app.close();
  await pool.end();
});

beforeEach(() => {
  nextReply = { kind: "acknowledgement", message: "Got it." };
  nextVerdict = "unclear";
  shouldThrow = false;
  calls = [];
});

test("POST /test-sessions requires auth", async () => {
  const res = await app.inject({ method: "POST", url: "/test-sessions" });
  assert.equal(res.statusCode, 401);
});

test("navigation and focus events save without triggering the AI reviewer", async () => {
  const start = await app.inject({
    method: "POST",
    url: "/test-sessions",
    headers: { authorization: `Bearer ${tokenA}` },
  });
  const { session } = start.json();

  const nav = await app.inject({
    method: "POST",
    url: `/test-sessions/${session.id}/events`,
    headers: { authorization: `Bearer ${tokenA}` },
    payload: { eventType: "navigation", pagePath: "/" },
  });
  assert.equal(nav.statusCode, 200);
  assert.equal(nav.json().event.event_type, "navigation");
  assert.equal(nav.json().aiReply, undefined);
  assert.equal(calls.length, 0);

  const focus = await app.inject({
    method: "POST",
    url: `/test-sessions/${session.id}/events`,
    headers: { authorization: `Bearer ${tokenA}` },
    payload: { eventType: "focus", pagePath: "/", fieldLabel: "Rate" },
  });
  assert.equal(focus.json().event.field_label, "Rate");
  assert.equal(calls.length, 0);
});

test("rejects an unknown eventType and a comment with no note", async () => {
  const start = await app.inject({
    method: "POST",
    url: "/test-sessions",
    headers: { authorization: `Bearer ${tokenA}` },
  });
  const { session } = start.json();

  const badType = await app.inject({
    method: "POST",
    url: `/test-sessions/${session.id}/events`,
    headers: { authorization: `Bearer ${tokenA}` },
    payload: { eventType: "click", pagePath: "/" },
  });
  assert.equal(badType.statusCode, 400);

  const noNote = await app.inject({
    method: "POST",
    url: `/test-sessions/${session.id}/events`,
    headers: { authorization: `Bearer ${tokenA}` },
    payload: { eventType: "comment", pagePath: "/" },
  });
  assert.equal(noNote.statusCode, 400);
});

test("a comment gets a clarifying-question reply and creates no action", async () => {
  nextReply = { kind: "clarifying_question", message: "Which page were you on?" };

  const start = await app.inject({
    method: "POST",
    url: "/test-sessions",
    headers: { authorization: `Bearer ${tokenA}` },
  });
  const { session } = start.json();

  const comment = await app.inject({
    method: "POST",
    url: `/test-sessions/${session.id}/events`,
    headers: { authorization: `Bearer ${tokenA}` },
    payload: { eventType: "comment", pagePath: "/", note: "Something looks off." },
  });
  const body = comment.json();
  assert.equal(body.event.event_type, "comment");
  assert.equal(body.aiReply.note, "Which page were you on?");
  assert.equal(body.action, undefined);
  assert.deepEqual(calls, ["reply"]);
});

test("a comment describing a problem proposes an action, and the tester's next reply confirms it", async () => {
  nextReply = { kind: "proposed_action", message: "Rename the button to Create organization." };

  const start = await app.inject({
    method: "POST",
    url: "/test-sessions",
    headers: { authorization: `Bearer ${tokenA}` },
  });
  const { session } = start.json();

  const comment = await app.inject({
    method: "POST",
    url: `/test-sessions/${session.id}/events`,
    headers: { authorization: `Bearer ${tokenA}` },
    payload: { eventType: "comment", pagePath: "/", note: "This button label is confusing." },
  });
  const action = comment.json().action;
  assert.equal(action.status, "open");

  nextVerdict = "confirmed";
  const confirm = await app.inject({
    method: "POST",
    url: `/test-sessions/${session.id}/events`,
    headers: { authorization: `Bearer ${tokenA}` },
    payload: { eventType: "comment", pagePath: "/", note: "Yes, that would fix it." },
  });
  const body = confirm.json();
  assert.equal(body.action.id, action.id);
  assert.equal(body.action.status, "accepted");
  assert.equal(body.aiReply, undefined);
  assert.deepEqual(calls, ["reply", "confirmation"]);
});

test("a decline dismisses the action; an unrelated reply falls through to a normal AI reply", async () => {
  nextReply = { kind: "proposed_action", message: "Add a loading spinner." };
  const start = await app.inject({
    method: "POST",
    url: "/test-sessions",
    headers: { authorization: `Bearer ${tokenA}` },
  });
  const { session } = start.json();
  await app.inject({
    method: "POST",
    url: `/test-sessions/${session.id}/events`,
    headers: { authorization: `Bearer ${tokenA}` },
    payload: { eventType: "comment", pagePath: "/", note: "This feels slow." },
  });

  nextVerdict = "declined";
  const decline = await app.inject({
    method: "POST",
    url: `/test-sessions/${session.id}/events`,
    headers: { authorization: `Bearer ${tokenA}` },
    payload: { eventType: "comment", pagePath: "/", note: "No, don't bother." },
  });
  assert.equal(decline.json().action.status, "dismissed");

  nextVerdict = "unclear";
  nextReply = { kind: "acknowledgement", message: "Noted." };
  const unrelated = await app.inject({
    method: "POST",
    url: `/test-sessions/${session.id}/events`,
    headers: { authorization: `Bearer ${tokenA}` },
    payload: { eventType: "comment", pagePath: "/", note: "Anyway, moving on." },
  });
  assert.equal(unrelated.json().aiReply.note, "Noted.");
  assert.equal(unrelated.json().action, undefined);
});

test("an AI failure never blocks the comment from saving", async () => {
  shouldThrow = true;
  const start = await app.inject({
    method: "POST",
    url: "/test-sessions",
    headers: { authorization: `Bearer ${tokenA}` },
  });
  const { session } = start.json();

  const comment = await app.inject({
    method: "POST",
    url: `/test-sessions/${session.id}/events`,
    headers: { authorization: `Bearer ${tokenA}` },
    payload: { eventType: "comment", pagePath: "/", note: "Anything." },
  });
  assert.equal(comment.statusCode, 200);
  const body = comment.json();
  assert.equal(body.event.note, "Anything.");
  assert.equal(body.aiReply, undefined);
  assert.equal(body.action, undefined);
});

test("a session is private: a different account can't read it, post to it, or end it", async () => {
  const start = await app.inject({
    method: "POST",
    url: "/test-sessions",
    headers: { authorization: `Bearer ${tokenA}` },
  });
  const { session } = start.json();

  const read = await app.inject({
    method: "GET",
    url: `/test-sessions/${session.id}/events`,
    headers: { authorization: `Bearer ${tokenB}` },
  });
  assert.equal(read.statusCode, 404);

  const post = await app.inject({
    method: "POST",
    url: `/test-sessions/${session.id}/events`,
    headers: { authorization: `Bearer ${tokenB}` },
    payload: { eventType: "navigation", pagePath: "/" },
  });
  assert.equal(post.statusCode, 404);

  const end = await app.inject({
    method: "PATCH",
    url: `/test-sessions/${session.id}`,
    headers: { authorization: `Bearer ${tokenB}` },
  });
  assert.equal(end.statusCode, 404);
});

test("PATCH /test-sessions/:id ends a session, and GET /test-sessions lists it", async () => {
  const start = await app.inject({
    method: "POST",
    url: "/test-sessions",
    headers: { authorization: `Bearer ${tokenA}` },
    payload: { label: "Smoke pass" },
  });
  const { session } = start.json();

  const end = await app.inject({
    method: "PATCH",
    url: `/test-sessions/${session.id}`,
    headers: { authorization: `Bearer ${tokenA}` },
  });
  assert.notEqual(end.json().session.ended_at, null);

  const list = await app.inject({
    method: "GET",
    url: "/test-sessions",
    headers: { authorization: `Bearer ${tokenA}` },
  });
  const ids = list.json().sessions.map((s) => s.id);
  assert.ok(ids.includes(session.id));
});
