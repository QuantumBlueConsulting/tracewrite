// tracewrite's Express router: mounts the same five session/timeline routes
// as plugin.mjs's Fastify plugin, e.g.
//
//   app.use("/test-sessions", createTestSessionExpressRouter({ getPool, authenticate, statusByCode }));
//
// Targets Nest apps on @nestjs/platform-express (mount against the Nest
// app's underlying Express instance) as well as plain Express apps. Not for
// @nestjs/platform-fastify — use plugin.mjs's Fastify plugin there instead.
//
// The host must:
//   - provide a `getPool` returning a `pg` Pool connected to a database that
//     has run this package's migration (packages/schema/migrations —
//     test_session/test_session_event/test_session_action, no RLS);
//   - provide `authenticate`, an Express middleware `(req, res, next)` that
//     populates `req.user.sub` with the caller's account id — same contract
//     as the Fastify plugin's `authenticate` decorator, just Express-shaped;
//   - have JSON body parsing already applied ahead of this router (e.g.
//     `express.json()`, which Nest's Express platform applies by default);
//   - optionally pass a `statusByCode` map for TestSessionError's two codes
//     ("invalid_input", "not_found") to HTTP statuses — a host missing an
//     entry falls back to 400.
import { Router } from "express";
import { createTestSessionsApi, TestSessionError } from "./sessions.mjs";

/**
 * @param {{getPool: () => import("pg").Pool, authenticate: import("express").RequestHandler, statusByCode?: Record<string, number>}} deps
 */
export function createTestSessionExpressRouter({ getPool, authenticate, statusByCode = {} }) {
  const { startSession, endSession, logEvent, listSessions, listEvents, listActions } = createTestSessionsApi({
    getPool,
  });

  const router = Router();
  router.use(authenticate);

  function handleError(res, next, err) {
    if (err instanceof TestSessionError) {
      res.status(statusByCode[err.code] ?? 400).json({ error: err.code, message: err.message });
      return;
    }
    next(err);
  }

  router.post("/", async (req, res, next) => {
    try {
      const accountId = /** @type {{sub: string}} */ (/** @type {any} */ (req).user).sub;
      const session = await startSession({ accountId, label: req.body?.label });
      res.json({ session });
    } catch (err) {
      handleError(res, next, err);
    }
  });

  router.get("/", async (req, res, next) => {
    try {
      const accountId = /** @type {{sub: string}} */ (/** @type {any} */ (req).user).sub;
      const sessions = await listSessions({ accountId });
      res.json({ sessions });
    } catch (err) {
      handleError(res, next, err);
    }
  });

  router.patch("/:id", async (req, res, next) => {
    try {
      const accountId = /** @type {{sub: string}} */ (/** @type {any} */ (req).user).sub;
      const session = await endSession({ accountId, sessionId: req.params.id });
      res.json({ session });
    } catch (err) {
      handleError(res, next, err);
    }
  });

  router.get("/:id/events", async (req, res, next) => {
    try {
      const accountId = /** @type {{sub: string}} */ (/** @type {any} */ (req).user).sub;
      const events = await listEvents({ accountId, sessionId: req.params.id });
      res.json({ events });
    } catch (err) {
      handleError(res, next, err);
    }
  });

  router.get("/:id/actions", async (req, res, next) => {
    try {
      const accountId = /** @type {{sub: string}} */ (/** @type {any} */ (req).user).sub;
      const actions = await listActions({ accountId, sessionId: req.params.id });
      res.json({ actions });
    } catch (err) {
      handleError(res, next, err);
    }
  });

  router.post("/:id/events", async (req, res, next) => {
    try {
      const accountId = /** @type {{sub: string}} */ (/** @type {any} */ (req).user).sub;
      const body = req.body ?? {};
      const result = await logEvent({
        accountId,
        sessionId: req.params.id,
        eventType: body.eventType,
        pagePath: body.pagePath,
        fieldLabel: body.fieldLabel,
        note: body.note,
      });
      res.json(result);
    } catch (err) {
      handleError(res, next, err);
    }
  });

  return router;
}
