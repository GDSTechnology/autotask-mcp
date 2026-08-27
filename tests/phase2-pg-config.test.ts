// PostgreSQL config + capability flags (Expansion Spec §17, issue #18).

import { isPgEnabled, loadPgConfig, loadPgFlags } from '../src/db/config';

const base = { MCP_PG_ENABLED: 'true', MCP_PG_PASSWORD: 'devapp' } as NodeJS.ProcessEnv;

describe('isPgEnabled', () => {
  test('off by default, on only for "true"', () => {
    expect(isPgEnabled({} as any)).toBe(false);
    expect(isPgEnabled({ MCP_PG_ENABLED: 'false' } as any)).toBe(false);
    expect(isPgEnabled({ MCP_PG_ENABLED: 'TRUE' } as any)).toBe(true);
  });
});

describe('loadPgConfig', () => {
  test('sane defaults', () => {
    const c = loadPgConfig(base);
    expect(c).toMatchObject({
      host: 'localhost', port: 5432, database: 'gds_autotask_mcp',
      schema: 'autotask_mcp', user: 'gds_autotask_mcp_app', ssl: false, poolMax: 10,
    });
  });

  test('overrides + ssl parsing', () => {
    const c = loadPgConfig({
      ...base, MCP_PG_HOST: 'db.vps', MCP_PG_PORT: '5433', MCP_PG_SCHEMA: 'autotask_mcp',
      MCP_PG_SSL: 'require', MCP_PG_POOL_MAX: '20',
    } as any);
    expect(c.host).toBe('db.vps');
    expect(c.port).toBe(5433);
    expect(c.ssl).toBe('require');
    expect(c.poolMax).toBe(20);
  });

  test('bad port/pool fall back to defaults', () => {
    const c = loadPgConfig({ ...base, MCP_PG_PORT: 'x', MCP_PG_POOL_MAX: '-3' } as any);
    expect(c.port).toBe(5432);
    expect(c.poolMax).toBe(10);
  });

  test('enabled without a password throws (fail loud)', () => {
    expect(() => loadPgConfig({ MCP_PG_ENABLED: 'true' } as any)).toThrow(/MCP_PG_PASSWORD/);
  });

  test('disabled without a password does not throw', () => {
    expect(() => loadPgConfig({} as any)).not.toThrow();
  });
});

describe('loadPgFlags', () => {
  test('all inert when the master switch is off, even if individually set', () => {
    const f = loadPgFlags({ MCP_PG_AUDIT_ENABLED: 'true', MCP_PG_JOBS_ENABLED: 'true' } as any);
    expect(f.audit).toBe(false);
    expect(f.jobs).toBe(false);
  });

  test('flags honored when the master switch is on', () => {
    const f = loadPgFlags({ MCP_PG_ENABLED: 'true', MCP_PG_AUDIT_ENABLED: 'true' } as any);
    expect(f.audit).toBe(true);
    expect(f.jobs).toBe(false);
  });
});
