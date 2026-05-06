/**
 * Tests for the credential storage layer.
 *
 * Security focus:
 *  - File mode MUST be 0600 (owner-only) — anything looser exposes the
 *    bearer token to other local users.
 *  - Write must be atomic — partial writes never leave a half-token at the
 *    final path.
 *  - Read must tolerate a missing or corrupt file without crashing.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  readCredentials,
  writeCredentials,
  deleteCredentials,
} from './storage';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reentry-storage-'));
  process.env.XDG_CONFIG_HOME = tmpRoot;
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.XDG_CONFIG_HOME;
});

describe('writeCredentials', () => {
  it('writes a JSON file at mode 0600', () => {
    writeCredentials({
      apiUrl: 'https://api.example.test',
      accessToken: 'mcp_re_secret',
      issuedAt: '2026-05-04T18:00:00.000Z',
    });

    const file = path.join(tmpRoot, 'reentry', 'credentials.json');
    const stat = fs.statSync(file);

    // mode & 0o777 strips the file-type bits; we only care about permissions.
    const perms = stat.mode & 0o777;
    expect(perms).toBe(0o600);
  });

  it('creates the parent directory at mode 0700 when absent', () => {
    writeCredentials({
      apiUrl: 'https://api.example.test',
      accessToken: 'mcp_re_secret',
      issuedAt: '2026-05-04T18:00:00.000Z',
    });

    const dir = path.join(tmpRoot, 'reentry');
    const dirPerms = fs.statSync(dir).mode & 0o777;
    expect(dirPerms).toBe(0o700);
  });

  it('overwrites prior credentials atomically (no .tmp file remains)', () => {
    writeCredentials({
      apiUrl: 'https://api.example.test',
      accessToken: 'mcp_re_first',
      issuedAt: '2026-05-04T18:00:00.000Z',
    });
    writeCredentials({
      apiUrl: 'https://api.example.test',
      accessToken: 'mcp_re_second',
      issuedAt: '2026-05-04T18:00:01.000Z',
    });

    const dir = path.join(tmpRoot, 'reentry');
    const entries = fs.readdirSync(dir);
    expect(entries).toContain('credentials.json');
    // No leftover .tmp files.
    expect(entries.filter((f) => f.includes('.tmp'))).toHaveLength(0);

    const read = readCredentials();
    expect(read?.accessToken).toBe('mcp_re_second');
  });
});

describe('readCredentials', () => {
  it('returns null when file does not exist', () => {
    expect(readCredentials()).toBeNull();
  });

  it('returns the stored credentials after write', () => {
    const creds = {
      apiUrl: 'https://api.example.test',
      accessToken: 'mcp_re_secret',
      issuedAt: '2026-05-04T18:00:00.000Z',
    };
    writeCredentials(creds);

    expect(readCredentials()).toEqual(creds);
  });

  it('returns null on a corrupt file (does not throw)', () => {
    const dir = path.join(tmpRoot, 'reentry');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'credentials.json'), '{not json}', {
      mode: 0o600,
    });

    expect(readCredentials()).toBeNull();
  });

  it('returns null when the JSON is missing required fields', () => {
    const dir = path.join(tmpRoot, 'reentry');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'credentials.json'),
      JSON.stringify({ apiUrl: 'x' }), // missing accessToken, issuedAt
      { mode: 0o600 },
    );

    expect(readCredentials()).toBeNull();
  });

  it('auto-tightens a world-readable credentials file and warns', () => {
    writeCredentials({
      apiUrl: 'https://api.example.test',
      accessToken: 'mcp_re_secret',
      issuedAt: '2026-05-04T18:00:00.000Z',
    });
    const file = path.join(tmpRoot, 'reentry', 'credentials.json');
    fs.chmodSync(file, 0o644);

    // Capture stderr — readCredentials should warn but still succeed.
    const writes: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    (process.stderr.write as unknown as (s: string) => boolean) = ((
      s: string,
    ): boolean => {
      writes.push(s);
      return true;
    }) as typeof process.stderr.write;

    try {
      const result = readCredentials();
      expect(result?.accessToken).toBe('mcp_re_secret');
    } finally {
      process.stderr.write = original;
    }

    // Mode should now be 0600.
    const perms = fs.statSync(file).mode & 0o777;
    expect(perms).toBe(0o600);

    // A warning should have been written.
    expect(writes.some((w) => w.includes('tightening to 0600'))).toBe(true);
  });
});

describe('deleteCredentials', () => {
  it('returns false when no file exists', () => {
    expect(deleteCredentials()).toBe(false);
  });

  it('deletes an existing credentials file', () => {
    writeCredentials({
      apiUrl: 'x',
      accessToken: 'y',
      issuedAt: 'z',
    });
    expect(deleteCredentials()).toBe(true);
    expect(readCredentials()).toBeNull();
  });
});
