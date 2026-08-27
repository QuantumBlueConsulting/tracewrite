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
- **`@quantumblueconsulting/tracewrite-server`** — a Fastify plugin (`createTestSessionRoutes`) *or*
  an Express router (`createTestSessionExpressRouter`, also covers Nest apps on
  `@nestjs/platform-express`), both thin wrappers over the same host-agnostic session/timeline
  logic and AI review step. Bring your own `pg` Pool and an `authenticate` hook/middleware.
- **`@quantumblueconsulting/tracewrite-client`** — `TestingOverlay` and `TestSessionScreen`, React
  components with no router of their own (works under react-router, Next.js App Router, or
  anything else that can give you a pathname), plus an optional ready-made `TracewriteClient`
  (`createFetchTracewriteClient`) over `fetch`.

## Installing

```sh
npm install @quantumblueconsulting/tracewrite-server   # your API
npm install @quantumblueconsulting/tracewrite-client   # your web app
```

Published to npm under MIT. No registry configuration and no authentication — earlier versions
lived on GitHub Packages, which requires a token even for public packages, and that made the
packages unusable from any container build that installs dependencies without one.

`tracewrite-schema` is not published — it is a single SQL file. Copy it out of
[`packages/schema/migrations/`](packages/schema/migrations/) and run it with whatever migration
tool you already use.

Both packages ship source rather than a build. Bundlers that do not compile dependencies by
default need to be told to — in Next.js, for example:

```ts
// next.config.ts
transpilePackages: ["@quantumblueconsulting/tracewrite-client"],
```

## Wiring it into a host app

**1. Run the migration** (`packages/schema/migrations/0001_add_test_session.sql`) against your
database.

**2. Server** — mount the routes under an authenticated app. Pick the adapter for your framework:

Fastify:

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

Express, or Nest on `@nestjs/platform-express` (mount against the Nest app's underlying Express
instance — this does not work with `@nestjs/platform-fastify`; use the Fastify plugin there instead):

```js
import { createTestSessionExpressRouter } from "@quantumblueconsulting/tracewrite-server";

app.use(
  "/test-sessions",
  createTestSessionExpressRouter({
    getPool: () => myPgPool,
    authenticate: myAuthMiddleware, // (req, res, next) => populates req.user.sub
    statusByCode: { invalid_input: 400, not_found: 404 },
  })
);
```

Requires JSON body parsing already applied ahead of the router (e.g. `express.json()`, which
Nest's Express platform applies by default).

**3. Client** — pass a `TracewriteClient` to both components. The built-in fetch client covers most
setups:

```tsx
import {
  TestingOverlay,
  TestSessionScreen,
  isTestingModeEnabled,
  createFetchTracewriteClient,
} from "@quantumblueconsulting/tracewrite-client";
import "@quantumblueconsulting/tracewrite-client/styles.css";

const client = createFetchTracewriteClient({
  baseUrl: "/test-sessions",
  getHeaders: () => ({ Authorization: `Bearer ${myAuthToken}` }),
});

// mounted once, as a sibling of your router's routes so it persists across navigation.
// pathname comes from whatever router you use:
//   react-router: useLocation().pathname
//   Next.js App Router: usePathname() from "next/navigation"
<TestingOverlay client={client} active={isSignedIn && isTestingModeEnabled("myapp.testingMode")} pathname={pathname} />

// mounted at whatever route you choose, wrapped in your own page chrome.
// sessionId comes from your router's own param (react-router's useParams().id,
// a Next.js dynamic route's params.id) — omit it for the session list view:
<TestSessionScreen client={client} sessionId={sessionId} />
```

A host with a non-fetch HTTP layer, or a different auth scheme, can implement `TracewriteClient`
directly instead — it's a plain six-method interface over the same five REST routes:

```tsx
const client: TracewriteClient = {
  startSession: (label) => myApi.post("/test-sessions", { label }),
  endSession: (id) => myApi.patch(`/test-sessions/${id}`),
  logEvent: (id, input) => myApi.post(`/test-sessions/${id}/events`, input),
  listSessions: () => myApi.get("/test-sessions"),
  listEvents: (id) => myApi.get(`/test-sessions/${id}/events`),
  listActions: (id) => myApi.get(`/test-sessions/${id}/actions`),
};
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

## License

MIT — see [LICENSE](LICENSE).
