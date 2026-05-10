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
