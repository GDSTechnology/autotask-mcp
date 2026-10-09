-- 0008_operations — operation log + durable idempotency (gap register MCP-007).
--
-- One row per tool call that wrote to Autotask, or that carried an explicit
-- idempotencyKey. Ties together the caller's correlationId, the upstream
-- decision (decisionId, e.g. a Hermes recommendation), the caller's references
-- (n8n workflow / node / executionId / eventId), and every Autotask write the
-- call made (mcp_operation_write) — so a TicketHistory row by the MCP's API user
-- can be traced back to the decision that caused it.
--
-- idempotency_key is unique: a key is claimed (status running) BEFORE the call
-- executes, so a retry or a concurrent duplicate cannot write twice, across
-- restarts and instances. status: running | ok | error (nothing written —
-- retryable) | partial (failed after writing — never auto-retried).

CREATE TABLE IF NOT EXISTS mcp_operation (
  operation_id     uuid        PRIMARY KEY,
  correlation_id   text        NOT NULL,
  decision_id      text,
  idempotency_key  text,
  tool             text        NOT NULL,
  args_digest      text,
  source           text        NOT NULL,
  caller           jsonb,
  refs             jsonb,
  status           text        NOT NULL,
  started_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz,
  result_text      text,
  error            text
);

CREATE UNIQUE INDEX IF NOT EXISTS mcp_operation_idem ON mcp_operation (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS mcp_operation_correlation ON mcp_operation (correlation_id);
CREATE INDEX IF NOT EXISTS mcp_operation_decision    ON mcp_operation (decision_id) WHERE decision_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS mcp_operation_started     ON mcp_operation (started_at);

CREATE TABLE IF NOT EXISTS mcp_operation_write (
  id            bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  operation_id  uuid        NOT NULL REFERENCES mcp_operation (operation_id) ON DELETE CASCADE,
  at            timestamptz NOT NULL,
  method        text        NOT NULL,
  path          text        NOT NULL,
  entity_type   text,
  entity_id     bigint,
  parent_type   text,
  parent_id     bigint
);

CREATE INDEX IF NOT EXISTS mcp_operation_write_op     ON mcp_operation_write (operation_id);
CREATE INDEX IF NOT EXISTS mcp_operation_write_entity ON mcp_operation_write (entity_type, entity_id, at);
CREATE INDEX IF NOT EXISTS mcp_operation_write_parent ON mcp_operation_write (parent_type, parent_id, at);
