# @quantumblueconsulting/tracewrite-client

Frontend for [tracewrite](https://github.com/QuantumBlueConsulting/tracewrite), a conversational UAT
capture overlay: a tester browses your real, authenticated product while narrating, and an AI
reviewer replies inline with a clarifying question or a proposed follow-up action.

`TestingOverlay` rides along with your app, auto-logging page and focused-field *context* — a
field's label, never its value — and letting the tester attach comments to it. `TestSessionScreen`
reads a session back. Neither has a router of its own: you pass the current pathname in, so it
mounts under react-router, Next.js App Router, or anything else.

```sh
npm install @quantumblueconsulting/tracewrite-client
```

Ships source rather than a build, so bundlers that skip dependencies need telling — in Next.js,
`transpilePackages: ["@quantumblueconsulting/tracewrite-client"]`.

Full wiring instructions are in the
[repository README](https://github.com/QuantumBlueConsulting/tracewrite#readme).

MIT licensed.
