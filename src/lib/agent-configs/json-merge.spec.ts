/**
 * Tests for the JSON read/merge/write primitives used by agent-config
 * writers (claude-code.ts, cursor.ts).
 *
 * Security focus:
 *  - Atomic write: never leaves a half-written config at the final path.
 *  - File mode 0600 on the temp file (which is what gets renamed into
 *    place). The bearer token lives inside this file — anything looser
 *    than owner-read/write exposes it to other local users.
 *  - Backup once per write (single-ring, no leak). Loud failure on
 *    corrupt input — we refuse to silently overwrite a user's broken
 *    config, since the rename would lose their data.
 *  - `deepEqual` is what powers idempotent re-install detection; an
 *    asymmetry here would cause spurious "stale config" prompts.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  readJsonObject,
  writeJsonObjectAtomic,
  deepEqual,
} from './json-merge';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reentry-json-merge-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('readJsonObject', () => {
  it('returns an empty object when the file does not exist (caller can merge from a fresh slate)', () => {
    const result = readJsonObject(path.join(tmpRoot, 'missing.json'));
    expect(result).toEqual({});
  });

  it('returns an empty object on an empty file (treated as fresh)', () => {
    const file = path.join(tmpRoot, 'empty.json');
    fs.writeFileSync(file, '   \n  ');
    expect(readJsonObject(file)).toEqual({});
  });

  it('parses an existing object', () => {
    const file = path.join(tmpRoot, 'existing.json');
    fs.writeFileSync(file, JSON.stringify({ a: 1, b: { c: 2 } }));
    expect(readJsonObject(file)).toEqual({ a: 1, b: { c: 2 } });
  });

  it('throws loudly on a non-object JSON value (refuses to overwrite a user array)', () => {
    const file = path.join(tmpRoot, 'array.json');
    fs.writeFileSync(file, '[1, 2, 3]');
    expect(() => readJsonObject(file)).toThrow(/not a JSON object/);
  });

  it('throws on a corrupt JSON file (user backs it up themselves)', () => {
    const file = path.join(tmpRoot, 'corrupt.json');
    fs.writeFileSync(file, '{not real json');
    expect(() => readJsonObject(file)).toThrow();
  });
});

describe('writeJsonObjectAtomic', () => {
  it('writes the final file at mode 0600 (token lives here)', () => {
    const file = path.join(tmpRoot, 'settings.json');
    writeJsonObjectAtomic(file, { reentry: { token: 'mcp_re_secret' } });

    const perms = fs.statSync(file).mode & 0o777;
    expect(perms).toBe(0o600);
  });

  it('creates the parent directory when absent', () => {
    const file = path.join(tmpRoot, 'nested', 'deep', 'settings.json');
    writeJsonObjectAtomic(file, { a: 1 });
    expect(fs.existsSync(file)).toBe(true);
  });

  it('cleans up the temp file after rename (no .pid.tmp leftovers)', () => {
    const file = path.join(tmpRoot, 'settings.json');
    writeJsonObjectAtomic(file, { a: 1 });
    const stragglers = fs
      .readdirSync(tmpRoot)
      .filter((entry) => entry.includes('.tmp'));
    expect(stragglers).toEqual([]);
  });

  it('writes one .reentry-bak ring backup before overwriting an existing file', () => {
    const file = path.join(tmpRoot, 'settings.json');
    writeJsonObjectAtomic(file, { version: 1 });
    writeJsonObjectAtomic(file, { version: 2 });

    const backup = `${file}.reentry-bak`;
    expect(fs.existsSync(backup)).toBe(true);
    expect(JSON.parse(fs.readFileSync(backup, 'utf8'))).toEqual({ version: 1 });
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ version: 2 });
  });

  it('does not produce a backup on the FIRST write (no previous file to preserve)', () => {
    const file = path.join(tmpRoot, 'settings.json');
    writeJsonObjectAtomic(file, { version: 1 });
    expect(fs.existsSync(`${file}.reentry-bak`)).toBe(false);
  });

  it('serialises with two-space indent + trailing newline (matches the rest of the project)', () => {
    const file = path.join(tmpRoot, 'settings.json');
    writeJsonObjectAtomic(file, { a: 1, b: 2 });

    const raw = fs.readFileSync(file, 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw).toContain('  "a": 1');
  });
});

describe('deepEqual', () => {
  it('treats identical primitives as equal', () => {
    expect(deepEqual(1, 1)).toBe(true);
    expect(deepEqual('a', 'a')).toBe(true);
    expect(deepEqual(true, true)).toBe(true);
    expect(deepEqual(null, null)).toBe(true);
  });

  it('treats null vs non-null as unequal (the original asymmetric guard)', () => {
    expect(deepEqual(null, {})).toBe(false);
    expect(deepEqual({}, null)).toBe(false);
  });

  it('compares plain objects key-by-key regardless of insertion order', () => {
    expect(deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
  });

  it('rejects objects with different keys', () => {
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  });

  it('recurses into nested objects', () => {
    expect(
      deepEqual({ a: { b: { c: [1, 2, 3] } } }, { a: { b: { c: [1, 2, 3] } } }),
    ).toBe(true);
    expect(
      deepEqual({ a: { b: { c: [1, 2, 3] } } }, { a: { b: { c: [1, 2, 4] } } }),
    ).toBe(false);
  });

  it('treats arrays of different length as unequal', () => {
    expect(deepEqual([1, 2], [1, 2, 3])).toBe(false);
  });

  it('treats array vs object as unequal', () => {
    expect(deepEqual([1, 2], { 0: 1, 1: 2 })).toBe(false);
  });
});
