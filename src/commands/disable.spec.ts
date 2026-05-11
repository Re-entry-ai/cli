/**
 * Tests for the `reentry disable` command — the counterpart to `init`.
 *
 * Security focus:
 *  - NEVER deletes a foreign pre-commit hook (one without our marker).
 *  - Restores any backup placed by `init` so user state survives a
 *    full install/disable round-trip.
 *  - Does NOT touch the credentials file — that's `logout`'s job. The
 *    JSON envelope advertises the credentials path so a CI script can
 *    surface the hint without grepping the human-readable output.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { disableCommand } from './disable';
import { installPreCommitHook } from '../lib/git-hook';
import { ExitCodes } from '../lib/exit-codes';

const stdoutSpy = jest
  .spyOn(process.stdout, 'write')
  .mockImplementation(() => true);
const stderrSpy = jest
  .spyOn(process.stderr, 'write')
  .mockImplementation(() => true);

let prevCwd: string;
let tmpRoot: string;

function gitInit(): void {
  const result = spawnSync('git', ['init', '--quiet'], { stdio: 'ignore' });
  if (result.status !== 0) {
    throw new Error('git init failed in test setup');
  }
}

beforeEach(() => {
  prevCwd = process.cwd();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reentry-disable-'));
  process.chdir(tmpRoot);
  stdoutSpy.mockClear();
  stderrSpy.mockClear();
});

afterEach(() => {
  process.chdir(prevCwd);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('disableCommand', () => {
  it('removes a reentry-managed hook (json mode)', async () => {
    gitInit();
    installPreCommitHook();

    const code = await disableCommand({ json: true });

    expect(code).toBe(ExitCodes.ALLOWED);
    const output = stdoutSpy.mock.calls.map((call) => call[0]).join('').trim();
    const parsed = JSON.parse(output);
    expect(parsed.success).toBe(true);
    expect(parsed.hook.outcome).toBe('removed');
    expect(parsed.hint).toContain('reentry logout');
    expect(fs.existsSync(path.join('.git', 'hooks', 'pre-commit'))).toBe(false);
  });

  it('restores the user backup when one is present', async () => {
    gitInit();
    // Seed a user hook before reentry install — that path triggers the
    // `preserved_existing` install branch, which writes a `.reentry-backup`
    // alongside the new managed shim.
    const hookPath = path.join('.git', 'hooks', 'pre-commit');
    fs.mkdirSync(path.dirname(hookPath), { recursive: true });
    fs.writeFileSync(hookPath, '#!/bin/sh\necho "user"\n', { mode: 0o755 });

    installPreCommitHook();

    const code = await disableCommand({ json: true });
    expect(code).toBe(ExitCodes.ALLOWED);

    const output = stdoutSpy.mock.calls.map((call) => call[0]).join('').trim();
    const parsed = JSON.parse(output);
    expect(parsed.hook.outcome).toBe('restored_backup');

    // User's original hook is back, backup file gone.
    expect(fs.readFileSync(hookPath, 'utf8')).toBe(
      '#!/bin/sh\necho "user"\n',
    );
    expect(fs.existsSync(`${hookPath}.reentry-backup`)).toBe(false);
  });

  it('returns absent (success) when no hook is present at all', async () => {
    gitInit();

    const code = await disableCommand({ json: true });
    expect(code).toBe(ExitCodes.ALLOWED);

    const output = stdoutSpy.mock.calls.map((call) => call[0]).join('').trim();
    const parsed = JSON.parse(output);
    expect(parsed.hook.outcome).toBe('absent');
  });

  it('refuses to delete a foreign pre-commit hook (USAGE exit, hook untouched)', async () => {
    gitInit();
    const hookPath = path.join('.git', 'hooks', 'pre-commit');
    fs.mkdirSync(path.dirname(hookPath), { recursive: true });
    fs.writeFileSync(hookPath, '#!/bin/sh\necho "third-party"\n', {
      mode: 0o755,
    });

    const code = await disableCommand({ json: true });
    expect(code).toBe(ExitCodes.USAGE);

    const output = stdoutSpy.mock.calls.map((call) => call[0]).join('').trim();
    const parsed = JSON.parse(output);
    expect(parsed.success).toBe(false);
    expect(parsed.hook.outcome).toBe('foreign_hook');
    // The foreign hook is NOT removed.
    expect(fs.readFileSync(hookPath, 'utf8')).toBe(
      '#!/bin/sh\necho "third-party"\n',
    );
  });

  it('returns USAGE when invoked outside a git repository', async () => {
    // tmpRoot is not git-init'ed here.
    const code = await disableCommand({ json: true });
    expect(code).toBe(ExitCodes.USAGE);

    const output = stdoutSpy.mock.calls.map((call) => call[0]).join('').trim();
    const parsed = JSON.parse(output);
    expect(parsed.hook.outcome).toBe('not_a_repo');
  });

  it("does NOT delete the credentials file (that's logout's job)", async () => {
    // We don't write a credentials file here, but the hint must be
    // surfaced in the JSON output so a CI / dashboard surface can echo it.
    gitInit();
    installPreCommitHook();

    await disableCommand({ json: true });
    const output = stdoutSpy.mock.calls.map((call) => call[0]).join('').trim();
    const parsed = JSON.parse(output);
    expect(parsed.hint).toContain('reentry logout');
    expect(parsed.hint).toContain('credentials');
  });
});
