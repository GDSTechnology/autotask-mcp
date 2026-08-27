#!/bin/bash
# One-time init (runs on an empty data volume) — builds the production role model
# in the local test DB so migrations and app code behave identically here and on
# the prod VPS (Expansion Spec §17.2/§17.3, #18).
#
#   owner    — NOLOGIN group role; owns the schema and all objects.
#   migrator — LOGIN; runs migrations (DDL). Objects it creates are owned by owner.
#   app      — LOGIN; the MCP's runtime identity. DML only, NO DDL.
#
# To re-run, recreate the volume: docker compose -f dev-postgres/docker-compose.yml down -v
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "gds_autotask_mcp" <<-EOSQL
  -- Roles
  CREATE ROLE gds_autotask_mcp_owner NOLOGIN;
  CREATE ROLE gds_autotask_mcp_migrator LOGIN PASSWORD '${MCP_PG_MIGRATOR_PASSWORD}';
  CREATE ROLE gds_autotask_mcp_app LOGIN PASSWORD '${MCP_PG_APP_PASSWORD}';

  -- Schema owned by the owner group
  CREATE SCHEMA IF NOT EXISTS autotask_mcp AUTHORIZATION gds_autotask_mcp_owner;

  -- Migrator can create objects; make it a member of owner so migrations can
  -- create owner-owned objects (SET ROLE gds_autotask_mcp_owner in the migrator).
  GRANT gds_autotask_mcp_owner TO gds_autotask_mcp_migrator;
  GRANT USAGE, CREATE ON SCHEMA autotask_mcp TO gds_autotask_mcp_migrator;

  -- App: schema usage + DML on current and future objects; explicitly NO CREATE/DDL.
  GRANT USAGE ON SCHEMA autotask_mcp TO gds_autotask_mcp_app;
  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA autotask_mcp TO gds_autotask_mcp_app;
  GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA autotask_mcp TO gds_autotask_mcp_app;
  -- Cover objects created later by either owner or migrator.
  ALTER DEFAULT PRIVILEGES FOR ROLE gds_autotask_mcp_owner IN SCHEMA autotask_mcp
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO gds_autotask_mcp_app;
  ALTER DEFAULT PRIVILEGES FOR ROLE gds_autotask_mcp_owner IN SCHEMA autotask_mcp
    GRANT USAGE, SELECT ON SEQUENCES TO gds_autotask_mcp_app;
  ALTER DEFAULT PRIVILEGES FOR ROLE gds_autotask_mcp_migrator IN SCHEMA autotask_mcp
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO gds_autotask_mcp_app;
  ALTER DEFAULT PRIVILEGES FOR ROLE gds_autotask_mcp_migrator IN SCHEMA autotask_mcp
    GRANT USAGE, SELECT ON SEQUENCES TO gds_autotask_mcp_app;

  -- Lock down the database surface: no ad-hoc objects in public, connect gated.
  REVOKE CREATE ON SCHEMA public FROM PUBLIC;
  REVOKE ALL ON DATABASE gds_autotask_mcp FROM PUBLIC;
  GRANT CONNECT ON DATABASE gds_autotask_mcp TO gds_autotask_mcp_app, gds_autotask_mcp_migrator;
EOSQL

echo "gds_autotask_mcp: roles + schema initialized."
