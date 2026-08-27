# @quantumblueconsulting/tracewrite-server

Backend for [tracewrite](https://github.com/QuantumBlueConsulting/tracewrite), a conversational UAT
capture overlay: a tester browses your real, authenticated product while narrating, and an AI
reviewer replies inline with a clarifying question or a proposed follow-up action.

This package is the session/timeline logic plus two HTTP adapters — a Fastify plugin
(`createTestSessionRoutes`) and an Express router (`createTestSessionExpressRouter`, which also
covers Nest apps on `@nestjs/platform-express`). Both are thin wrappers over the same
host-agnostic core. Bring your own `pg` Pool and your own authentication.

```sh
npm install @quantumblueconsulting/tracewrite-server
```

Run the migration from `@quantumblueconsulting/tracewrite-schema` first, then mount the adapter for
your framework. Full wiring instructions, the client half, and the privacy model are in the
[repository README](https://github.com/QuantumBlueConsulting/tracewrite#readme).

MIT licensed.
