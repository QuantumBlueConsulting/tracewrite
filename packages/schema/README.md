# @quantumblueconsulting/tracewrite-schema

Plain SQL, not a migration-runner dependency: `migrations/0001_add_test_session.sql` creates
`test_session`, `test_session_event`, `test_session_action`. Run it through whatever migration tool
your host project already uses (it's a single file with an "Up Migration" and a "Down Migration"
section, node-pg-migrate/Flyway/plain-`psql` compatible).

No RLS, no foreign key to any accounts table (see the migration's header comment for why and how to
add your own), no `GRANT` baked in — the migration comments show the shape, you decide the role name.
