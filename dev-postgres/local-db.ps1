<#
.SYNOPSIS
  Local ephemeral PostgreSQL for dev testing of the optional PG layer (§17, #18).

.DESCRIPTION
  Manages a portable Postgres cluster staged under a gitignored runtime dir
  (dev-postgres/.runtime/), so the ~300MB binaries are downloaded ONCE and the
  cluster persists between sessions. Spin up/down on demand without wasting cycles.

  DEV-ONLY. Dev passwords are baked in below and are never used in production
  (prod points MCP_PG_* at the VPS with real secrets). Nothing here is committed
  except this script.

.USAGE
  ./dev-postgres/local-db.ps1 <command>

    provision   One-time: download+extract binaries, initdb, create DB/roles/schema, migrate.
    up          Start the server (provisions first if needed).
    down        Stop the server, keep everything staged.
    status      Show running state + audit_log row count.
    migrate     Build + run the migration runner against the local DB.
    psql        Open psql as the app role (pass extra args after --, e.g. psql -- -c "select 1").
    reset       Drop + recreate the DB (keep binaries), then migrate. Wipes data.
    purge       Stop and delete the entire runtime dir (forces a fresh download next time).
    env         Print the MCP_PG_* block to point the MCP at this local DB.
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet('provision', 'up', 'down', 'status', 'migrate', 'psql', 'reset', 'purge', 'env', 'help')]
  [string]$Command = 'help',
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Rest
)

$ErrorActionPreference = 'Stop'

# --- config (dev-only) -------------------------------------------------------
$PgVersion = '16.9-1'
$Port      = 5433
$Db        = 'gds_autotask_mcp'
$Schema    = 'autotask_mcp'
$OwnerRole = 'gds_autotask_mcp_owner'
$MigRole   = 'gds_autotask_mcp_migrator'
$AppRole   = 'gds_autotask_mcp_app'
$SuperPw   = 'devsuperpass'
$MigPw     = 'devmigrate'
$AppPw     = 'devapp'

$Root     = Join-Path $PSScriptRoot '.runtime'
$Bin      = Join-Path $Root 'pgsql\bin'
$Data     = Join-Path $Root 'data'
$LogFile  = Join-Path $Root 'server.log'
$RepoRoot = Split-Path $PSScriptRoot -Parent

function Exe([string]$name) { Join-Path $Bin $name }
function Is-Running { [bool](Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -eq $Port }) }

function Set-PgEnv {
  $env:MCP_PG_ENABLED = 'true'; $env:MCP_PG_AUDIT_ENABLED = 'true'
  $env:MCP_PG_HOST = 'localhost'; $env:MCP_PG_PORT = "$Port"
  $env:MCP_PG_DATABASE = $Db; $env:MCP_PG_SCHEMA = $Schema
  $env:MCP_PG_USER = $AppRole; $env:MCP_PG_PASSWORD = $AppPw
  $env:MCP_PG_MIGRATOR_USER = $MigRole; $env:MCP_PG_MIGRATOR_PASSWORD = $MigPw
  $env:MCP_PG_SSL = 'false'
}

function Ensure-Binaries {
  if (Test-Path (Exe 'postgres.exe')) { return }
  New-Item -ItemType Directory -Force $Root | Out-Null
  $zip = Join-Path $Root 'pg.zip'
  if (-not (Test-Path $zip)) {
    Write-Host "Downloading PostgreSQL $PgVersion (one-time) ..."
    $ProgressPreference = 'SilentlyContinue'
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest "https://get.enterprisedb.com/postgresql/postgresql-$PgVersion-windows-x64-binaries.zip" -OutFile $zip -UseBasicParsing
  }
  Write-Host 'Extracting binaries ...'
  Expand-Archive -Path $zip -DestinationPath $Root -Force
  Remove-Item $zip -Force -ErrorAction SilentlyContinue
}

function Init-Cluster {
  if (Test-Path (Join-Path $Data 'PG_VERSION')) { return }
  Write-Host 'Initializing cluster ...'
  $pwf = Join-Path $Root 'pw.txt'; Set-Content $pwf $SuperPw -NoNewline -Encoding ascii
  & (Exe 'initdb.exe') -D $Data -U postgres --auth=trust --encoding=UTF8 --pwfile=$pwf | Out-Null
  Remove-Item $pwf -Force -ErrorAction SilentlyContinue
}

function Start-Server {
  if (Is-Running) { return }
  Write-Host "Starting Postgres on port $Port ..."
  & (Exe 'pg_ctl.exe') -D $Data -o "-p $Port" -l $LogFile -w start | Out-Null
}

function Stop-Server {
  if (-not (Test-Path (Join-Path $Data 'postmaster.pid'))) { Write-Host 'Already stopped.'; return }
  Write-Host 'Stopping Postgres ...'
  & (Exe 'pg_ctl.exe') -D $Data -m fast -w stop | Out-Null
}

function Ensure-DbAndRoles {
  $env:PGPASSWORD = $SuperPw
  $exists = & (Exe 'psql.exe') -h localhost -p $Port -U postgres -d postgres -tAc "select 1 from pg_database where datname='$Db'"
  if ("$exists".Trim() -eq '1') { return }
  Write-Host "Creating database, roles, schema ($Db / $Schema) ..."
  $setup = @"
DO `$`$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='$OwnerRole') THEN CREATE ROLE $OwnerRole NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='$MigRole')   THEN CREATE ROLE $MigRole LOGIN PASSWORD '$MigPw'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='$AppRole')   THEN CREATE ROLE $AppRole LOGIN PASSWORD '$AppPw'; END IF;
END `$`$;
CREATE DATABASE $Db;
\connect $Db
CREATE SCHEMA IF NOT EXISTS $Schema AUTHORIZATION $OwnerRole;
GRANT $OwnerRole TO $MigRole;
GRANT USAGE, CREATE ON SCHEMA $Schema TO $MigRole;
GRANT USAGE ON SCHEMA $Schema TO $AppRole;
ALTER DEFAULT PRIVILEGES FOR ROLE $OwnerRole IN SCHEMA $Schema GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO $AppRole;
ALTER DEFAULT PRIVILEGES FOR ROLE $OwnerRole IN SCHEMA $Schema GRANT USAGE, SELECT ON SEQUENCES TO $AppRole;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON DATABASE $Db FROM PUBLIC;
GRANT CONNECT ON DATABASE $Db TO $AppRole, $MigRole;
"@
  $tmp = Join-Path $Root 'setup.sql'; Set-Content $tmp $setup -Encoding ascii
  & (Exe 'psql.exe') -h localhost -p $Port -U postgres -d postgres -v ON_ERROR_STOP=1 -f $tmp | Out-Null
  Remove-Item $tmp -Force -ErrorAction SilentlyContinue
}

function Invoke-Migrate {
  Push-Location $RepoRoot
  try {
    Write-Host 'Building ...'; & npm run build | Out-Null
    Set-PgEnv
    Write-Host 'Migrating ...'; & node (Join-Path $RepoRoot 'dist\db\migrate.js')
  } finally { Pop-Location }
}

switch ($Command) {
  'provision' { Ensure-Binaries; Init-Cluster; Start-Server; Ensure-DbAndRoles; Invoke-Migrate; Write-Host "`nProvisioned + running on localhost:$Port." }
  'up'        { Ensure-Binaries; Init-Cluster; Start-Server; Ensure-DbAndRoles; Write-Host "Up on localhost:$Port." }
  'down'      { Stop-Server; Write-Host 'Down (staged — run `up` to resume).' }
  'status'    {
    if (Is-Running) {
      Write-Host "RUNNING on localhost:$Port"
      $env:PGPASSWORD = $AppPw
      $n = & (Exe 'psql.exe') -h localhost -p $Port -U $AppRole -d $Db -tAc "select count(*) from $Schema.audit_log" 2>$null
      if ($n) { Write-Host "audit_log rows: $($n.Trim())" }
    } else { Write-Host 'STOPPED' }
  }
  'migrate'   { if (-not (Is-Running)) { Ensure-Binaries; Init-Cluster; Start-Server; Ensure-DbAndRoles }; Invoke-Migrate }
  'psql'      { $env:PGPASSWORD = $AppPw; & (Exe 'psql.exe') -h localhost -p $Port -U $AppRole -d $Db @Rest }
  'reset'     {
    if (-not (Is-Running)) { Ensure-Binaries; Init-Cluster; Start-Server }
    $env:PGPASSWORD = $SuperPw
    Write-Host "Dropping + recreating $Db ..."
    & (Exe 'psql.exe') -h localhost -p $Port -U postgres -d postgres -c "DROP DATABASE IF EXISTS $Db WITH (FORCE);" | Out-Null
    Ensure-DbAndRoles; Invoke-Migrate
  }
  'purge'     { Stop-Server; Start-Sleep -Seconds 1; if (Test-Path $Root) { Remove-Item -Recurse -Force $Root -ErrorAction SilentlyContinue }; Write-Host 'Purged (next provision re-downloads).' }
  'env'       { Set-PgEnv; @('MCP_PG_ENABLED','MCP_PG_HOST','MCP_PG_PORT','MCP_PG_DATABASE','MCP_PG_SCHEMA','MCP_PG_USER','MCP_PG_PASSWORD','MCP_PG_AUDIT_ENABLED') | ForEach-Object { "$_=$([Environment]::GetEnvironmentVariable($_,'Process'))" } }
  default     { Get-Help $PSCommandPath -Detailed }
}
