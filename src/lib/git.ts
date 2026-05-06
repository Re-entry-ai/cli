import { spawnSync } from 'child_process';

/**
 * Read the staged diff (`git diff --cached`) of the current repo.
 *
 * Returns null if the spawn fails (not in a repo, git not installed).
 * Returns empty string if the repo has no staged changes — caller should
 * treat that as "nothing to check, exit 0".
 */
export function readStagedDiff(): string | null {
  return runGit(['diff', '--cached']);
}

/**
 * Read the diff of the most recent commit. Used by `reentry init` when
 * running its first pre-commit check on a repo that has no staged changes
 * yet — gives the user a meaningful first result.
 */
export function readLastCommitDiff(): string | null {
  return runGit(['show', '--no-color', 'HEAD']);
}

/** Current branch name, or null if detached/no repo. */
export function readCurrentBranch(): string | null {
  return runGit(['rev-parse', '--abbrev-ref', 'HEAD'])?.trim() || null;
}

function runGit(args: string[]): string | null {
  const result = spawnSync('git', args, {
    encoding: 'utf8',
    // No shell — args go directly to git (no injection surface).
    shell: false,
  });

  if (result.status !== 0) {
    return null;
  }

  return result.stdout;
}
