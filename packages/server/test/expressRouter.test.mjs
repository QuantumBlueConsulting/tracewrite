// Standalone harness: a minimal Express app wired the way an Express/Nest
// host is expected to wire it (a test-only header-based `authenticate`
// middleware, createTestSessionExpressRouter mounted at /test-sessions),
// against a real Postgres that's had this package's migration applied. The
// Anthropic client is mocked at the module boundary, same as sessions.test.mjs.
//
// This suite proves the Express-specific wiring (params, body parsing,
// status-code mapping, auth middleware invocation) — the AI review branch
// logic itself (decline/unrelated-reply handling) is already fully covered
// by sessions.test.mjs's Fastify harness against the same shared sessions.mjs.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import express from "express";
import pg from "pg";
import { createTestSessionExpressRouter } from "../src/expressRouter.mjs";
import { setTestSessionAiClientForTesting } from "../src/ai.mjs";

const STATUS_BY_CODE = { invalid_input: 400, not_found: 404 };

let pool;
let server;
let baseUrl;
const accountA = randomUUID();
const accountB = randomUUID();

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

// Test-only stand-in for a real Express auth middleware: reads the account
// id straight off a header instead of verifying a JWT, since no single JWT
// library is a QuantumBlue-wide standard for Express/Nest hosts.
function authenticate(req, res, next) {
  const accountId = req.header("x-account-id");
  if (!accountId) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }
  req.user = { sub: accountId };
  next();
}

async function call(method, path, { accountId, body } = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(accountId ? { "x-account-id": accountId } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, json: () => JSON.parse(text) };
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

  const app = express();
  app.use(express.json());
  app.use("/test-sessions", createTestSessionExpressRouter({ getPool, authenticate, statusByCode: STATUS_BY_CODE }));

  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/test-sessions`;
});

after(async () => {
  await pool.query(`DROP TABLE IF EXISTS test_session_action, test_session_event, test_session;`);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

beforeEach(() => {
  nextReply = { kind: "acknowledgement", message: "Got it." };
  nextVerdict = "unclear";
  shouldThrow = false;
  calls = [];
});

test("POST /test-sessions requires auth", async () => {
  const res = await call("POST", "");
  assert.equal(res.status, 401);
});

test("navigation and focus events save without triggering the AI reviewer", async () => {
  const start = await call("POST", "", { accountId: accountA });
  const { session } = start.json();

  const nav = await call("POST", `/${session.id}/events`, {
    accountId: accountA,
    body: { eventType: "navigation", pagePath: "/" },
  });
  assert.equal(nav.status, 200);
  assert.equal(nav.json().event.event_type, "navigation");
  assert.equal(calls.length, 0);
});

test("rejects an unknown eventType and a comment with no note", async () => {
  const start = await call("POST", "", { accountId: accountA });
  const { session } = start.json();

  const badType = await call("POST", `/${session.id}/events`, {
    accountId: accountA,
    body: { eventType: "click", pagePath: "/" },
  });
  assert.equal(badType.status, 400);

  const noNote = await call("POST", `/${session.id}/events`, {
    accountId: accountA,
    body: { eventType: "comment", pagePath: "/" },
  });
  assert.equal(noNote.status, 400);
});

test("a comment describing a problem proposes an action", async () => {
  nextReply = { kind: "proposed_action", message: "Rename the button to Create organization." };

  const start = await call("POST", "", { accountId: accountA });
  const { session } = start.json();

  const comment = await call("POST", `/${session.id}/events`, {
    accountId: accountA,
    body: { eventType: "comment", pagePath: "/", note: "This button label is confusing." },
  });
  const body = comment.json();
  assert.equal(body.event.event_type, "comment");
  assert.equal(body.action.status, "open");
  assert.deepEqual(calls, ["reply"]);
});

test("a session is private: a different account can't read it, post to it, or end it", async () => {
  const start = await call("POST", "", { accountId: accountA });
  const { session } = start.json();

  const read = await call("GET", `/${session.id}/events`, { accountId: accountB });
  assert.equal(read.status, 404);

  const post = await call("POST", `/${session.id}/events`, {
    accountId: accountB,
    body: { eventType: "navigation", pagePath: "/" },
  });
  assert.equal(post.status, 404);

  const end = await call("PATCH", `/${session.id}`, { accountId: accountB });
  assert.equal(end.status, 404);
});

test("PATCH /test-sessions/:id ends a session, and GET /test-sessions lists it", async () => {
  const start = await call("POST", "", { accountId: accountA, body: { label: "Smoke pass" } });
  const { session } = start.json();

  const end = await call("PATCH", `/${session.id}`, { accountId: accountA });
  assert.notEqual(end.json().session.ended_at, null);

  const list = await call("GET", "", { accountId: accountA });
  const ids = list.json().sessions.map((s) => s.id);
  assert.ok(ids.includes(session.id));
});
