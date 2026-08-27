// Pure migration-file helpers (Expansion Spec §17.2, issue #18). The DB-bound
// runner is exercised against the ephemeral dev Postgres, not in unit tests.

import { computeChecksum, loadMigrationFiles, migrationsDir } from '../src/db/migrate';

describe('computeChecksum', () => {
  test('stable and CRLF-insensitive', () => {
    const lf = computeChecksum('a\nb\n');
    const crlf = computeChecksum('a\r\nb\r\n');
    expect(lf).toBe(crlf);
    expect(lf).toHaveLength(64);
  });

  test('changes when content changes', () => {
    expect(computeChecksum('a')).not.toBe(computeChecksum('b'));
  });
});

describe('loadMigrationFiles', () => {
  test('missing dir → empty', () => {
    expect(loadMigrationFiles('/no/such/dir')).toEqual([]);
  });

  test('loads and orders the real migrations directory', () => {
    const files = loadMigrationFiles(migrationsDir());
    expect(files.length).toBeGreaterThanOrEqual(1);
    // Sorted by name; every file has a 64-hex checksum and .sql content.
    const names = files.map((f) => f.name);
    expect(names).toEqual([...names].sort());
    expect(files[0].name).toBe('0001_audit_log.sql');
    expect(files[0].checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(files[0].content).toMatch(/CREATE TABLE IF NOT EXISTS audit_log/);
  });
});
