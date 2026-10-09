-- 0005_shadow_verify — results of the shadow consistency check: random mirrored
-- rows re-read from Autotask and compared field by field, plus mirror vs
-- Autotask row counts. One row per check run (nightly + on demand); the report
-- is the full per-entity result. Old runs are trimmed by the app.

CREATE TABLE IF NOT EXISTS shadow_verify_run (
  id       bigserial   PRIMARY KEY,
  at       timestamptz NOT NULL DEFAULT now(),
  trigger  text        NOT NULL,
  status   text        NOT NULL,
  report   jsonb       NOT NULL
);
CREATE INDEX IF NOT EXISTS shadow_verify_run_at ON shadow_verify_run (at DESC);
