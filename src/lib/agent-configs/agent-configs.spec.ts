/**
 * Tests for the Claude Code + Cursor MCP config writers.
 *
 * Security focus:
 *  - File mode 0600 after the write — the file holds a bearer token.
 *  - Path-prefix preservation: other keys (other MCP servers, unrelated
 *    settings) survive an install/uninstall round-trip.
 *  - Idempotency: re-installing the same spec is a no-op.
 *  - Stale detection: a different existing entry refuses to overwrite
 *    without --force.
 *  - These specs run against real disk in a tmp dir; the writer is pure
 *    fs operations, no network.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  addClaudeCode,
  removeClaudeCode,
  statusClaudeCode,
  claudeCodeConfigPath,
} from './claude-code';
import {
  addCursor,
  removeCursor,
  statusCursor,
  cursorConfigPath,
} from './cursor';
import { ReentryServerSpec } from './types';

let tmpRoot: string;
let originalHome: string | undefined;
let originalCwd: string;

const SPEC_A: ReentryServerSpec = {
  apiUrl: 'https://api.example.test',
  accessToken: 'mcp_re_tokenA',
};

const SPEC_B: ReentryServerSpec = {
  apiUrl: 'https://api.example.test',
  accessToken: 'mcp_re_tokenB',
};

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reentry-agent-cfg-'));
  // Redirect both home dir (global config path) and cwd (project config
  // path) into the tmp root so the spec doesn't touch real user state.
  originalHome = process.env.HOME;
  process.env.HOME = tmpRoot;
  originalCwd = process.cwd();
  process.chdir(tmpRoot);
});

afterEach(() => {
  process.chdir(originalCwd);
  process.env.HOME = originalHome;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('addClaudeCode', () => {
  it('writes a fresh config at 0600 with the reentry entry', () => {
    const result = addClaudeCode(SPEC_A, { global: false });
    expect(result.outcome).toBe('installed');

    const config = JSON.parse(fs.readFileSync(result.configPath, 'utf8'));
    expect(config.mcpServers['reentry-ai']).toMatchObject({
      type: 'http',
      headers: { Authorization: 'Bearer mcp_re_tokenA' },
    });

    const perms = fs.statSync(result.configPath).mode & 0o777;
    expect(perms).toBe(0o600);
  });

  it('is idempotent — re-running with the same spec returns noop and does not bump the mtime', () => {
    const first = addClaudeCode(SPEC_A, { global: false });
    const mtimeBefore = fs.statSync(first.configPath).mtimeMs;

    const second = addClaudeCode(SPEC_A, { global: false });
    expect(second.outcome).toBe('noop');
    // Idempotency means no second write — mtime is unchanged.
    expect(fs.statSync(first.configPath).mtimeMs).toBe(mtimeBefore);
  });

  it('refuses to overwrite a different existing reentry-ai entry without --force', () => {
    addClaudeCode(SPEC_A, { global: false });
    const result = addClaudeCode(SPEC_B, { global: false });
    expect(result.outcome).toBe('stale');

    // The on-disk file still has the OLD token — the writer refused.
    const config = JSON.parse(fs.readFileSync(result.configPath, 'utf8'));
    expect(config.mcpServers['reentry-ai'].headers.Authorization).toBe(
      'Bearer mcp_re_tokenA',
    );
  });

  it('overwrites the existing entry with --force', () => {
    addClaudeCode(SPEC_A, { global: false });
    const result = addClaudeCode(SPEC_B, { global: false, force: true });
    expect(result.outcome).toBe('updated');

    const config = JSON.parse(fs.readFileSync(result.configPath, 'utf8'));
    expect(config.mcpServers['reentry-ai'].headers.Authorization).toBe(
      'Bearer mcp_re_tokenB',
    );
  });

  it('preserves OTHER mcpServers entries when installing reentry-ai', () => {
    const file = claudeCodeConfigPath(false);
    fs.writeFileSync(
      file,
      JSON.stringify({
        unrelated: { value: 1 },
        mcpServers: {
          'their-server': {
            type: 'http',
            url: 'https://their.example.com',
          },
        },
      }),
    );

    addClaudeCode(SPEC_A, { global: false });

    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(config.unrelated).toEqual({ value: 1 });
    expect(config.mcpServers['their-server']).toBeDefined();
    expect(config.mcpServers['reentry-ai']).toBeDefined();
  });
});

describe('removeClaudeCode', () => {
  it('removes only the reentry-ai entry, preserves other servers and keys', () => {
    const file = claudeCodeConfigPath(false);
    fs.writeFileSync(
      file,
      JSON.stringify({
        unrelated: { value: 7 },
        mcpServers: {
          'their-server': { type: 'http', url: 'https://their.example.com' },
          'reentry-ai': { type: 'http', url: 'old' },
        },
      }),
    );

    const result = removeClaudeCode({ global: false });
    expect(result.outcome).toBe('removed');

    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(config.unrelated).toEqual({ value: 7 });
    expect(config.mcpServers['their-server']).toBeDefined();
    expect(config.mcpServers['reentry-ai']).toBeUndefined();
  });

  it('returns absent when the entry is not present (or the file is missing)', () => {
    const result = removeClaudeCode({ global: false });
    expect(result.outcome).toBe('absent');
  });
});

describe('statusClaudeCode', () => {
  it('reports installed=true after a successful add', () => {
    addClaudeCode(SPEC_A, { global: false });
    const status = statusClaudeCode({ global: false });
    expect(status.installed).toBe(true);
  });

  it('reports installed=false when no entry is present', () => {
    const status = statusClaudeCode({ global: false });
    expect(status.installed).toBe(false);
  });
});

describe('addCursor', () => {
  it('writes a fresh Cursor config at 0600 with the reentry entry under .cursor/mcp.json', () => {
    const result = addCursor(SPEC_A, { global: false });
    expect(result.outcome).toBe('installed');
    expect(result.configPath).toMatch(/\.cursor\/mcp\.json$/);

    const config = JSON.parse(fs.readFileSync(result.configPath, 'utf8'));
    // Cursor's schema has NO `type` discriminator — just url + headers.
    expect(config.mcpServers['reentry-ai']).toMatchObject({
      headers: { Authorization: 'Bearer mcp_re_tokenA' },
    });
    expect(config.mcpServers['reentry-ai'].type).toBeUndefined();

    const perms = fs.statSync(result.configPath).mode & 0o777;
    expect(perms).toBe(0o600);
  });

  it('is idempotent', () => {
    const first = addCursor(SPEC_A, { global: false });
    const mtimeBefore = fs.statSync(first.configPath).mtimeMs;

    const second = addCursor(SPEC_A, { global: false });
    expect(second.outcome).toBe('noop');
    expect(fs.statSync(first.configPath).mtimeMs).toBe(mtimeBefore);
  });

  it('preserves other Cursor mcpServers entries', () => {
    const file = cursorConfigPath(false);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        mcpServers: {
          'their-server': { url: 'https://their.example.com' },
        },
      }),
    );

    addCursor(SPEC_A, { global: false });

    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(config.mcpServers['their-server']).toBeDefined();
    expect(config.mcpServers['reentry-ai']).toBeDefined();
  });
});

describe('removeCursor', () => {
  it('removes only the reentry-ai entry, keeping a sibling server intact', () => {
    // Seed a sibling so the file isn't garbage-collected after removal.
    // (`removeCursor` deletes the file when removal leaves an empty root —
    // which is the right behavior, but means we need a sibling to assert
    // that "OTHER entries survive".)
    const file = cursorConfigPath(false);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        mcpServers: { 'their-server': { url: 'https://their.example.com' } },
      }),
    );
    addCursor(SPEC_A, { global: false, force: true });

    const result = removeCursor({ global: false });
    expect(result.outcome).toBe('removed');

    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(config.mcpServers['their-server']).toBeDefined();
    expect(config.mcpServers['reentry-ai']).toBeUndefined();
  });

  it('unlinks the file when removal leaves the root empty', () => {
    addCursor(SPEC_A, { global: false });
    const file = cursorConfigPath(false);
    expect(fs.existsSync(file)).toBe(true);

    const result = removeCursor({ global: false });
    expect(result.outcome).toBe('removed');
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe('statusCursor', () => {
  it('reports installed=true after a successful add', () => {
    addCursor(SPEC_A, { global: false });
    expect(statusCursor({ global: false }).installed).toBe(true);
  });
});
