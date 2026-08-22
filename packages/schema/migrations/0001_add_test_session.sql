-- Up Migration

-- tracewrite: a UAT capture overlay. A tester browses the real product with
-- an overlay active; the overlay auto-logs page/field context (never a
-- typed value) and lets the tester attach freeform comments to that
-- context. An AI reviewer reacts to each comment with a clarifying
-- question, a proposed follow-up action, or a plain acknowledgement, and
-- the tester's own next reply is what confirms or declines a proposed
-- action — never the proposing call itself.
--
-- account_id is a bare uuid, not a foreign key: this package has no opinion
-- on what an "account"/"user"/"tenant" is in your schema. If you want
-- referential integrity, add your own FK in a follow-up migration:
--   ALTER TABLE test_session ADD CONSTRAINT test_session_account_fk
--     FOREIGN KEY (account_id) REFERENCES <your_accounts_table> (id);
--
-- No RLS, deliberately account-scoped rather than org/tenant-scoped: a
-- tester may not hold any org/tenant membership yet, or may roam across
-- several during one UAT pass, so there's no single scoping id this data
-- could hang off beyond the account itself.

-- One row per UAT pass. Explicit start/end (not an unbounded rolling log per
-- account) so a session has a clean boundary and a human label to review
-- against later.
CREATE TABLE test_session (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL,
  label       text,
  started_at  timestamptz NOT NULL DEFAULT now(),
  ended_at    timestamptz
);

CREATE INDEX test_session_account_idx ON test_session (account_id, started_at DESC);

-- The running timeline. 'navigation'/'focus' rows are auto-captured context
-- (page_path + field_label only — field_label is a label/aria-label/name,
-- never a field's value, per the privacy floor above). 'comment' rows are
-- the tester's own freeform notes. 'ai_reply' rows are the AI reviewer's
-- responses to a comment (see test_session_action below for what happens
-- when a reply proposes an action).
CREATE TABLE test_session_event (
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

CREATE INDEX test_session_event_session_idx ON test_session_event (session_id, created_at);

-- One row per AI-proposed follow-up action. event_id points at the
-- 'ai_reply' event that proposed it. status starts 'open' and is flipped to
-- 'accepted'/'dismissed' only by the confirmation-classification step that
-- reads the tester's own next reply — never by the proposing call itself, so
-- "proposed" and "confirmed" stay genuinely distinct states, not the same
-- write happening twice.
CREATE TABLE test_session_action (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id   uuid NOT NULL REFERENCES test_session (id),
  event_id     uuid NOT NULL REFERENCES test_session_event (id),
  description  text NOT NULL,
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'dismissed')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX test_session_action_session_idx ON test_session_action (session_id, status);

-- Grant privileges to your app's own database role, e.g.:
--   GRANT SELECT, INSERT, UPDATE ON test_session TO your_app_role;        -- label/ended_at are mutable; no DELETE, ending a session is a status change
--   GRANT SELECT, INSERT ON test_session_event TO your_app_role;          -- append-only: a UAT timeline's value is being a complete, untampered record
--   GRANT SELECT, INSERT, UPDATE ON test_session_action TO your_app_role; -- UPDATE is only ever status/updated_at in practice; no DELETE

-- Down Migration

DROP TABLE IF EXISTS test_session_action;
DROP TABLE IF EXISTS test_session_event;
DROP TABLE IF EXISTS test_session;
