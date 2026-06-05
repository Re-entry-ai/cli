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

/**
 * Read `owner/repo` from `git remote get-url origin`, parsing both SSH
 * (`git@github.com:owner/repo.git`) and HTTPS (`https://github.com/owner/repo[.git]`)
 * forms. Returns null if not in a repo, no `origin` remote, or the URL
 * doesn't match a recognized GitHub shape — caller is expected to fall
 * back to requiring an explicit --repository flag.
 *
 * Only GitHub is recognized for v0.2 (matches the backend's GitHub-first
 * integration). GitLab/Bitbucket parsing can be added when those backends
 * are added.
 */
export function readRemoteOriginUrl(): string | null {
  const raw = runGit(['config', '--get', 'remote.origin.url']);
  if (!raw) {
    return null;
  }
  const url = raw.trim();

  // SSH: git@github.com:owner/repo.git
  const sshMatch = url.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
  if (sshMatch) {
    return `${sshMatch[1]}/${sshMatch[2]}`;
  }

  // HTTPS: https://github.com/owner/repo[.git]
  const httpsMatch = url.match(/^https?:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/);
  if (httpsMatch) {
    return `${httpsMatch[1]}/${httpsMatch[2]}`;
  }

  return null;
}

/**
 * Top-level path of the current git repo, or null if not inside one. Used
 * by the `init` welcome screen so the user sees which repo they're acting
 * on before picking a review preset.
 */
export function readRepoRoot(): string | null {
  return runGit(['rev-parse', '--show-toplevel'])?.trim() || null;
}

/**
 * Detect the repository's base branch.
 *
 * Tries, in order:
 *   1. `git symbolic-ref refs/remotes/origin/HEAD` — the remote's default branch.
 *   2. local `main`.
 *   3. local `master`.
 * Returns null if none exist (fresh repo, no remote, detached state).
 */
export function readBaseBranch(): string | null {
  const fromOriginHead = runGit(['symbolic-ref', 'refs/remotes/origin/HEAD']);
  if (fromOriginHead) {
    const trimmed = fromOriginHead.trim();
    const prefix = 'refs/remotes/origin/';
    if (trimmed.startsWith(prefix)) {
      return trimmed.slice(prefix.length);
    }
  }

  if (runGit(['rev-parse', '--verify', 'refs/heads/main']) !== null) {
    return 'main';
  }

  if (runGit(['rev-parse', '--verify', 'refs/heads/master']) !== null) {
    return 'master';
  }

  return null;
}

/**
 * Number of files changed between `base` and the current HEAD. Returns
 * null if the diff can't be computed (base ref missing, not in a repo).
 */
export function countFilesChangedVsBase(base: string): number | null {
  const output = runGit(['diff', '--name-only', `${base}...HEAD`]);
  if (output === null) {
    return null;
  }
  const trimmed = output.trim();
  if (trimmed.length === 0) {
    return 0;
  }
  return trimmed.split('\n').length;
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
