# tracewrite

A conversational UAT capture overlay. A tester browses your real, authenticated product with an
overlay active; it auto-logs navigation and focused-field *context* (page path, field label — never a
value) and lets the tester attach freeform comments to that context. An AI reviewer (`claude-haiku-4-5`)
reacts to each comment with a clarifying question, a proposed follow-up action, or a plain
acknowledgement — and the tester's own next reply is what confirms or declines a proposed action, never
the proposing call itself. The result is a punch list a team can act on, built from someone actually
using the product rather than a rigid test script.

## Packages

- **`@quantumblueconsulting/tracewrite-schema`** — the migration (`test_session`,
  `test_session_event`, `test_session_action`). Plain SQL, run it with whatever migration tool you
  already use.
- **`@quantumblueconsulting/tracewrite-server`** — a Fastify plugin (`createTestSessionRoutes`) plus
  the underlying session/timeline logic and the AI review step. Bring your own `pg` Pool and an
  `authenticate` decorator.
- **`@quantumblueconsulting/tracewrite-client`** — `TestingOverlay` and `TestSessionScreen`, React
  components that take a `TracewriteClient` adapter. No assumptions about your auth or HTTP layer.

## Wiring it into a host app

**1. Run the migration** (`packages/schema/migrations/0001_add_test_session.sql`) against your
database.

**2. Server** — mount the plugin under an authenticated Fastify app:

```js
import { createTestSessionRoutes } from "@quantumblueconsulting/tracewrite-server";

app.register(
  createTestSessionRoutes({
    getPool: () => myPgPool, // any function returning a pg.Pool
    statusByCode: { invalid_input: 400, not_found: 404 },
  }),
  { prefix: "/test-sessions" }
);
```

`authenticate` must already be decorated on `app` (an `onRequest` hook), and must populate
`request.user.sub` with the caller's account id — the shape `@fastify/jwt`'s default verify produces.

**3. Client** — implement `TracewriteClient` over your own fetch/auth layer, once, and pass it to both
components:

```tsx
import { TestingOverlay, TestSessionScreen, isTestingModeEnabled } from "@quantumblueconsulting/tracewrite-client";
import "@quantumblueconsulting/tracewrite-client/styles.css";

const client: TracewriteClient = {
  startSession: (label) => myApi.post("/test-sessions", { label }),
  endSession: (id) => myApi.patch(`/test-sessions/${id}`),
  logEvent: (id, input) => myApi.post(`/test-sessions/${id}/events`, input),
  listSessions: () => myApi.get("/test-sessions"),
  listEvents: (id) => myApi.get(`/test-sessions/${id}/events`),
  listActions: (id) => myApi.get(`/test-sessions/${id}/actions`),
};

// mounted once, as a sibling of your router's <Routes> so it persists across navigation:
<TestingOverlay client={client} active={isSignedIn && isTestingModeEnabled("myapp.testingMode")} />

// mounted at whatever route you choose, wrapped in your own page chrome:
<TestSessionScreen client={client} />
```

## AI review

Requires `ANTHROPIC_API_KEY` in the server's environment. A missing key or a failed AI call never
blocks a tester's comment from saving — it's caught and swallowed; the tester just doesn't get a reply
that round.

## Testing

`packages/server`'s suite spins up a minimal Fastify app against a real Postgres (`DATABASE_URL`) and
mocks the Anthropic client at the module boundary — no network calls, no API key needed to run it.

```
createdb tracewrite_test
DATABASE_URL=postgres://localhost:5432/tracewrite_test pnpm --filter @quantumblueconsulting/tracewrite-server test
```
