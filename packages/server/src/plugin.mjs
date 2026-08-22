// tracewrite's Fastify plugin: mounts the five session/timeline routes under
// whatever prefix the host registers it at, e.g.
//
//   app.register(createTestSessionRoutes({ getPool, statusByCode }), { prefix: "/test-sessions" });
//
// The host must:
//   - provide a `getPool` returning a `pg` Pool connected to a database that
//     has run this package's migration (packages/schema/migrations —
//     test_session/test_session_event/test_session_action, no RLS);
//   - decorate the app with `authenticate` (an onRequest hook) and populate
//     `request.user.sub` with the caller's account id — the same shape
//     @fastify/jwt's default verify produces;
//   - optionally pass a `statusByCode` map for TestSessionError's two codes
//     ("invalid_input", "not_found") to HTTP statuses — a host missing an
//     entry falls back to 400.
import { createTestSessionsApi, TestSessionError } from "./sessions.mjs";

/**
 * @param {{getPool: () => import("pg").Pool, statusByCode?: Record<string, number>}} deps
 */
export function createTestSessionRoutes({ getPool, statusByCode = {} }) {
  const { startSession, endSession, logEvent, listSessions, listEvents, listActions } = createTestSessionsApi({
    getPool,
  });

  return async function tracewriteRoutes(app) {
    app.post("/", { onRequest: [/** @type {any} */ (app).authenticate] }, async (request) => {
      const body = /** @type {{label?: string}} */ (request.body ?? {});
      const accountId = /** @type {{sub: string}} */ (request.user).sub;
      const session = await startSession({ accountId, label: body.label });
      return { session };
    });

    app.get("/", { onRequest: [/** @type {any} */ (app).authenticate] }, async (request) => {
      const accountId = /** @type {{sub: string}} */ (request.user).sub;
      const sessions = await listSessions({ accountId });
      return { sessions };
    });

    app.patch("/:id", { onRequest: [/** @type {any} */ (app).authenticate] }, async (request, reply) => {
      const { id } = /** @type {{id: string}} */ (request.params);
      const accountId = /** @type {{sub: string}} */ (request.user).sub;
      try {
        const session = await endSession({ accountId, sessionId: id });
        return { session };
      } catch (err) {
        if (err instanceof TestSessionError) {
          reply.code(statusByCode[err.code] ?? 400).send({ error: err.code, message: err.message });
          return;
        }
        throw err;
      }
    });

    app.get("/:id/events", { onRequest: [/** @type {any} */ (app).authenticate] }, async (request, reply) => {
      const { id } = /** @type {{id: string}} */ (request.params);
      const accountId = /** @type {{sub: string}} */ (request.user).sub;
      try {
        const events = await listEvents({ accountId, sessionId: id });
        return { events };
      } catch (err) {
        if (err instanceof TestSessionError) {
          reply.code(statusByCode[err.code] ?? 400).send({ error: err.code, message: err.message });
          return;
        }
        throw err;
      }
    });

    app.get("/:id/actions", { onRequest: [/** @type {any} */ (app).authenticate] }, async (request, reply) => {
      const { id } = /** @type {{id: string}} */ (request.params);
      const accountId = /** @type {{sub: string}} */ (request.user).sub;
      try {
        const actions = await listActions({ accountId, sessionId: id });
        return { actions };
      } catch (err) {
        if (err instanceof TestSessionError) {
          reply.code(statusByCode[err.code] ?? 400).send({ error: err.code, message: err.message });
          return;
        }
        throw err;
      }
    });

    app.post("/:id/events", { onRequest: [/** @type {any} */ (app).authenticate] }, async (request, reply) => {
      const { id } = /** @type {{id: string}} */ (request.params);
      const body =
        /** @type {{eventType: string, pagePath: string, fieldLabel?: string, note?: string}} */ (
          request.body ?? {}
        );
      const accountId = /** @type {{sub: string}} */ (request.user).sub;
      try {
        const result = await logEvent({
          accountId,
          sessionId: id,
          eventType: body.eventType,
          pagePath: body.pagePath,
          fieldLabel: body.fieldLabel,
          note: body.note,
        });
        return result;
      } catch (err) {
        if (err instanceof TestSessionError) {
          reply.code(statusByCode[err.code] ?? 400).send({ error: err.code, message: err.message });
          return;
        }
        throw err;
      }
    });
  };
}
