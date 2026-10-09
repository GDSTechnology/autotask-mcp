-- 0006_auth_block — the Autotask login-protection pause, saved so restarts and
-- deploys respect it (a restart during a lockout used to spend 3 more failed
-- logins at once). One row per API user while paused or held; deleted when the
-- login works again or an administrator presses "Retry now". `fp` is a
-- fingerprint of the credentials: a pause saved for other credentials (the
-- secret was changed) is ignored.

CREATE TABLE IF NOT EXISTS autotask_auth_block (
  tenant      text        PRIMARY KEY,
  since       timestamptz NOT NULL,
  until       timestamptz,
  failures    integer     NOT NULL,
  last_error  text        NOT NULL DEFAULT '',
  held        boolean     NOT NULL DEFAULT false,
  fp          text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
