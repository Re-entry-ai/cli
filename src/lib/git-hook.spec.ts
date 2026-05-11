/**
 * Tests for the git-hook installer.
 *
 * Operates inside a real `git init`-ed temp directory — the installer uses
 * `git rev-parse --git-dir` so a stub fs won't suffice.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import {
  installPreCommitHook,
  removePreCommitHook,
  probePreCommitHook,
} from './git-hook';

let prevCwd: string;
let tmpRoot: string;

beforeEach(() => {
  prevCwd = process.cwd();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reentry-hook-'));
  process.chdir(tmpRoot);
});

afterEach(() => {
  process.chdir(prevCwd);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function gitInit(): void {
  const r = spawnSync('git', ['init', '--quiet'], { stdio: 'ignore' });
  if (r.status !== 0) {
    throw new Error('git init failed in test setup');
  }
}

describe('installPreCommitHook', () => {
  it('returns not_a_repo when cwd is not a git repository', () => {
    const result = installPreCommitHook();
    expect(result.kind).toBe('not_a_repo');
  });

  it('writes a 0755 hook file when none exists', () => {
    gitInit();
    const result = installPreCommitHook();

    expect(result.kind).toBe('installed');
    if (result.kind !== 'installed') {
      return;
    }

    const stat = fs.statSync(result.path);
    expect(stat.mode & 0o777).toBe(0o755);

    const body = fs.readFileSync(result.path, 'utf8');
    expect(body).toContain('# managed-by: reentry-cli');
    expect(body).toContain('reentry pre-commit');
  });

  it('is idempotent — re-running on a managed hook returns already_managed', () => {
    gitInit();
    installPreCommitHook();

    const second = installPreCommitHook();
    expect(second.kind).toBe('already_managed');
  });

  it('does NOT clobber a user-written existing hook — backs it up', () => {
    gitInit();

    const hookPath = path.join('.git', 'hooks', 'pre-commit');
    const userScript = '#!/bin/sh\necho "user custom hook"\n';
    fs.mkdirSync(path.dirname(hookPath), { recursive: true });
    fs.writeFileSync(hookPath, userScript, { mode: 0o755 });

    const result = installPreCommitHook();
    expect(result.kind).toBe('preserved_existing');

    if (result.kind !== 'preserved_existing') {
      return;
    }

    const backup = fs.readFileSync(result.backup, 'utf8');
    expect(backup).toBe(userScript);

    const newHook = fs.readFileSync(result.path, 'utf8');
    expect(newHook).toContain('# managed-by: reentry-cli');
  });

  it('refreshes a managed hook body on re-run (handles older shim versions)', () => {
    gitInit();

    // Simulate an older managed hook with the marker but a different body.
    const hookPath = path.join('.git', 'hooks', 'pre-commit');
    fs.mkdirSync(path.dirname(hookPath), { recursive: true });
    fs.writeFileSync(
      hookPath,
      '#!/bin/sh\n# managed-by: reentry-cli\necho old-version\n',
      { mode: 0o755 },
    );

    const result = installPreCommitHook();
    expect(result.kind).toBe('already_managed');

    const refreshed = fs.readFileSync(hookPath, 'utf8');
    expect(refreshed).toContain('reentry pre-commit');
    expect(refreshed).not.toContain('echo old-version');
  });
});

describe('removePreCommitHook', () => {
  it('returns not_a_repo when cwd is not a git repository', () => {
    expect(removePreCommitHook().kind).toBe('not_a_repo');
  });

  it('returns absent when there is no pre-commit hook at all', () => {
    gitInit();
    expect(removePreCommitHook().kind).toBe('absent');
  });

  it('deletes a managed hook that has no backup alongside', () => {
    gitInit();
    const installed = installPreCommitHook();
    if (installed.kind !== 'installed') {
      throw new Error('precondition: install should succeed');
    }

    const result = removePreCommitHook();
    expect(result.kind).toBe('removed');
    expect(fs.existsSync(installed.path)).toBe(false);
  });

  it('restores .reentry-backup over the managed hook when present', () => {
    gitInit();

    // Seed a user hook, then install reentry — that produces a backup.
    const hookPath = path.join('.git', 'hooks', 'pre-commit');
    fs.mkdirSync(path.dirname(hookPath), { recursive: true });
    fs.writeFileSync(hookPath, '#!/bin/sh\necho "user-hook"\n', { mode: 0o755 });

    const installed = installPreCommitHook();
    expect(installed.kind).toBe('preserved_existing');

    const result = removePreCommitHook();
    expect(result.kind).toBe('restored_backup');

    // The user's original body should be back at the hook path; the
    // backup file should be gone.
    const restored = fs.readFileSync(hookPath, 'utf8');
    expect(restored).toBe('#!/bin/sh\necho "user-hook"\n');
    expect(fs.existsSync(`${hookPath}.reentry-backup`)).toBe(false);
  });

  it('refuses to delete a foreign pre-commit hook (no marker line)', () => {
    gitInit();
    const hookPath = path.join('.git', 'hooks', 'pre-commit');
    fs.mkdirSync(path.dirname(hookPath), { recursive: true });
    fs.writeFileSync(hookPath, '#!/bin/sh\necho "foreign hook"\n', {
      mode: 0o755,
    });

    const result = removePreCommitHook();
    expect(result.kind).toBe('foreign_hook');
    // The foreign hook should be untouched.
    expect(fs.readFileSync(hookPath, 'utf8')).toBe(
      '#!/bin/sh\necho "foreign hook"\n',
    );
  });
});

describe('probePreCommitHook', () => {
  it('reports inRepo=false outside a git repo', () => {
    const probe = probePreCommitHook();
    expect(probe.inRepo).toBe(false);
    expect(probe.exists).toBe(false);
  });

  it('reports exists=false when there is no hook in the repo', () => {
    gitInit();
    const probe = probePreCommitHook();
    expect(probe.inRepo).toBe(true);
    expect(probe.exists).toBe(false);
    expect(probe.managedByReentry).toBe(false);
  });

  it('reports managedByReentry=true after a reentry install', () => {
    gitInit();
    installPreCommitHook();

    const probe = probePreCommitHook();
    expect(probe.exists).toBe(true);
    expect(probe.managedByReentry).toBe(true);
  });

  it('reports managedByReentry=false for a foreign hook', () => {
    gitInit();
    const hookPath = path.join('.git', 'hooks', 'pre-commit');
    fs.mkdirSync(path.dirname(hookPath), { recursive: true });
    fs.writeFileSync(hookPath, '#!/bin/sh\necho "not ours"\n', { mode: 0o755 });

    const probe = probePreCommitHook();
    expect(probe.exists).toBe(true);
    expect(probe.managedByReentry).toBe(false);
  });
});
