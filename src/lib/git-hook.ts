import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

/**
 * Marker line written into `.git/hooks/pre-commit`. Lets `reentry init`
 * detect a previous install and either skip (idempotent re-run) or back
 * up an unrelated existing hook.
 */
const HOOK_MARKER = '# managed-by: reentry-cli';

const HOOK_BODY = `#!/bin/sh
${HOOK_MARKER}
# Run re-entry pre-commit governance check. Exit non-zero to block the commit.
# Auto-skip the check if reentry isn't installed (don't break the team for
# someone who hasn't run \`npm i -g @re-entry.ai/cli\` yet).
if ! command -v reentry >/dev/null 2>&1; then
  exit 0
fi
exec reentry pre-commit
`;

export type HookInstallResult =
  | { kind: 'installed'; path: string }
  | { kind: 'already_managed'; path: string }
  | { kind: 'preserved_existing'; path: string; backup: string }
  | { kind: 'not_a_repo' };

/**
 * Install (or update) the git pre-commit hook.
 *
 * - Not in a git repo  → returns 'not_a_repo'.
 * - No existing hook   → writes our shim, mode 0755.
 * - Existing reentry hook → no-op, returns 'already_managed'.
 * - Existing other hook → backs up to .reentry-backup, then writes our shim.
 *                          The backup path is returned so the user can
 *                          re-merge their custom logic if they want.
 */
export function installPreCommitHook(): HookInstallResult {
  const gitDir = findGitDir();
  if (!gitDir) {
    return { kind: 'not_a_repo' };
  }

  const hooksDir = path.join(gitDir, 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });

  const hookPath = path.join(hooksDir, 'pre-commit');

  if (fs.existsSync(hookPath)) {
    const existing = fs.readFileSync(hookPath, 'utf8');
    if (existing.includes(HOOK_MARKER)) {
      // Re-write the body anyway so older shim versions get refreshed.
      fs.writeFileSync(hookPath, HOOK_BODY, { mode: 0o755 });
      return { kind: 'already_managed', path: hookPath };
    }

    // Don't clobber a user's existing hook silently. Back it up.
    const backupPath = `${hookPath}.reentry-backup`;
    fs.writeFileSync(backupPath, existing, { mode: 0o755 });
    fs.writeFileSync(hookPath, HOOK_BODY, { mode: 0o755 });
    return { kind: 'preserved_existing', path: hookPath, backup: backupPath };
  }

  fs.writeFileSync(hookPath, HOOK_BODY, { mode: 0o755 });
  return { kind: 'installed', path: hookPath };
}

export type HookRemoveResult =
  | { kind: 'removed'; path: string }
  | {
      kind: 'restored_backup';
      path: string;
      backup: string;
    }
  | { kind: 'absent' }
  | { kind: 'foreign_hook'; path: string }
  | { kind: 'not_a_repo' };

/**
 * Counterpart of `installPreCommitHook` for `reentry disable`.
 *
 * Behaviour:
 *  - Not in a git repo → `not_a_repo`.
 *  - No pre-commit hook → `absent` (nothing to do).
 *  - Hook IS managed by reentry-cli (HOOK_MARKER present):
 *      - If `.reentry-backup` exists alongside, restore it (the user had
 *        a custom hook before `reentry init`; we put it back).
 *      - Otherwise, delete the file.
 *  - Hook exists but is NOT managed by reentry-cli → `foreign_hook`
 *    (refuse to delete someone else's hook).
 *
 * The credentials file is left alone — `reentry logout` is the right tool
 * for that. `disable` only undoes what `init` did.
 */
export function removePreCommitHook(): HookRemoveResult {
  const gitDir = findGitDir();
  if (!gitDir) {
    return { kind: 'not_a_repo' };
  }

  const hookPath = path.join(gitDir, 'hooks', 'pre-commit');
  if (!fs.existsSync(hookPath)) {
    return { kind: 'absent' };
  }

  const existing = fs.readFileSync(hookPath, 'utf8');
  if (!existing.includes(HOOK_MARKER)) {
    return { kind: 'foreign_hook', path: hookPath };
  }

  const backupPath = `${hookPath}.reentry-backup`;
  if (fs.existsSync(backupPath)) {
    const backupBody = fs.readFileSync(backupPath, 'utf8');
    fs.writeFileSync(hookPath, backupBody, { mode: 0o755 });
    fs.unlinkSync(backupPath);
    return { kind: 'restored_backup', path: hookPath, backup: backupPath };
  }

  fs.unlinkSync(hookPath);
  return { kind: 'removed', path: hookPath };
}

/**
 * Inspect the current pre-commit hook without changing anything. Used by
 * `reentry doctor` to report installation state.
 */
export function probePreCommitHook(): {
  inRepo: boolean;
  exists: boolean;
  managedByReentry: boolean;
  path: string | null;
} {
  const gitDir = findGitDir();
  if (!gitDir) {
    return { inRepo: false, exists: false, managedByReentry: false, path: null };
  }

  const hookPath = path.join(gitDir, 'hooks', 'pre-commit');
  if (!fs.existsSync(hookPath)) {
    return { inRepo: true, exists: false, managedByReentry: false, path: hookPath };
  }

  const existing = fs.readFileSync(hookPath, 'utf8');
  return {
    inRepo: true,
    exists: true,
    managedByReentry: existing.includes(HOOK_MARKER),
    path: hookPath,
  };
}

/**
 * Locate the `.git` directory for the cwd. Uses `git rev-parse --git-dir`
 * which handles worktrees, submodules, and `GIT_DIR` overrides cleanly.
 */
function findGitDir(): string | null {
  const result = spawnSync('git', ['rev-parse', '--git-dir'], {
    encoding: 'utf8',
    shell: false,
  });
  if (result.status !== 0) {
    return null;
  }
  const trimmed = result.stdout.trim();
  if (trimmed.length === 0) {
    return null;
  }
  return path.resolve(process.cwd(), trimmed);
}
