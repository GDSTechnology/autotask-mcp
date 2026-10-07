-- 0004_admin — the admin console: its users, sessions, runtime settings and a
-- change log. Users are local to the console (not Autotask resources). Two
-- roles: 'admin' (manage settings and users) and 'viewer' (read-only metrics).
-- Passwords are stored as scrypt hashes; sessions as SHA-256 hashes of the
-- cookie token, so a database read never yields a usable credential.

CREATE TABLE IF NOT EXISTS admin_user (
  id                    bigserial   PRIMARY KEY,
  username              text        NOT NULL,
  password_hash         text        NOT NULL,
  role                  text        NOT NULL CHECK (role IN ('admin', 'viewer')),
  must_change_password  boolean     NOT NULL DEFAULT true,
  disabled              boolean     NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            text,
  password_changed_at   timestamptz,
  last_login_at         timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS admin_user_username ON admin_user (lower(username));

CREATE TABLE IF NOT EXISTS admin_session (
  token_hash    text        PRIMARY KEY,
  user_id       bigint      NOT NULL REFERENCES admin_user (id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  ip            text,
  user_agent    text
);
CREATE INDEX IF NOT EXISTS admin_session_user ON admin_session (user_id);

-- Runtime settings changed from the console. Absent key = the env default.
CREATE TABLE IF NOT EXISTS admin_setting (
  key         text        PRIMARY KEY,
  value       jsonb       NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text
);

-- Who changed what in the console (logins, setting changes, user changes).
CREATE TABLE IF NOT EXISTS admin_event (
  id       bigserial   PRIMARY KEY,
  at       timestamptz NOT NULL DEFAULT now(),
  actor    text,
  action   text        NOT NULL,
  details  jsonb       NOT NULL DEFAULT '{}'::jsonb,
  ip       text
);
CREATE INDEX IF NOT EXISTS admin_event_at ON admin_event (at DESC);
