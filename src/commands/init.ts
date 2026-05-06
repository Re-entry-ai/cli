import kleur from 'kleur';
import { ExitCodes } from '../lib/exit-codes';
import { readCredentials } from '../lib/storage';
import { installPreCommitHook } from '../lib/git-hook';
import { loginCommand } from './login';
import { preCommitCommand } from './pre-commit';

interface InitOptions {
  json?: boolean;
  /** Skip the device-flow login step (assumes already logged in). */
  skipLogin?: boolean;
  /** Skip the git-hook install step. */
  skipHook?: boolean;
  /** Skip the first pre-commit run. */
  skipFirstCheck?: boolean;
}

interface InitJsonResult {
  ok: boolean;
  steps: {
    login: 'skipped' | 'already' | 'completed';
    hook:
      | 'skipped'
      | 'installed'
      | 'already_managed'
      | 'preserved_existing'
      | 'not_a_repo';
    firstCheck: 'skipped' | 'no_changes' | 'ran';
  };
  hookBackup?: string;
}

/**
 * `reentry init` — the hero command. Runs login → install git hook → first
 * pre-commit, in one flow. Idempotent: re-running it is safe.
 *
 * Exit codes are deliberately just 0 (success) or non-zero (something went
 * wrong); we don't propagate the pre-commit risk verdict here because the
 * goal is "get the user set up", not "tell them their last commit is bad."
 */
export async function initCommand(options: InitOptions): Promise<number> {
  const result: InitJsonResult = {
    ok: true,
    steps: {
      login: 'skipped',
      hook: 'skipped',
      firstCheck: 'skipped',
    },
  };

  // --- Step 1: login ---
  if (!options.skipLogin) {
    if (readCredentials()) {
      result.steps.login = 'already';
      if (!options.json) {
        process.stdout.write(`${kleur.green('✓')} Already logged in.\n`);
      }
    } else {
      const code = await loginCommand({ json: false });
      if (code !== ExitCodes.ALLOWED) {
        result.ok = false;
        if (options.json) {
          process.stdout.write(JSON.stringify(result) + '\n');
        }
        return code;
      }
      result.steps.login = 'completed';
    }
  }

  // --- Step 2: install git hook ---
  if (!options.skipHook) {
    const hookResult = installPreCommitHook();
    result.steps.hook = hookResult.kind;

    if (!options.json) {
      switch (hookResult.kind) {
        case 'installed':
          process.stdout.write(
            `${kleur.green('✓')} Installed git pre-commit hook.\n`,
          );
          break;
        case 'already_managed':
          process.stdout.write(
            `${kleur.green('✓')} Pre-commit hook already in place ${kleur.dim('(refreshed)')}.\n`,
          );
          break;
        case 'preserved_existing':
          result.hookBackup = hookResult.backup;
          process.stdout.write(
            `${kleur.yellow('!')} Pre-commit hook installed; your existing hook saved to ${hookResult.backup}.\n`,
          );
          process.stdout.write(
            kleur.dim(
              '  Re-merge any custom logic you need, then re-run `reentry init` to refresh.\n',
            ),
          );
          break;
        case 'not_a_repo':
          process.stdout.write(
            `${kleur.yellow('!')} Not a git repository — skipped hook install.\n`,
          );
          break;
      }
    }
  }

  // --- Step 3: first pre-commit run ---
  // We always run this in non-json mode so the user sees a result. In --json
  // mode we capture the outcome silently — the orchestrator can call
  // `reentry pre-commit --json` separately if it wants the full payload.
  if (!options.skipFirstCheck && readCredentials()) {
    if (!options.json) {
      process.stdout.write('\n');
      process.stdout.write(kleur.dim('Running first pre-commit check...\n'));
    }
    const code = await preCommitCommand({ json: false });
    if (code === ExitCodes.AUTH || code === ExitCodes.NETWORK) {
      // Treat auth/network as a real failure of init — the user should know.
      result.ok = false;
      if (options.json) {
        process.stdout.write(JSON.stringify(result) + '\n');
      }
      return code;
    }
    result.steps.firstCheck =
      code === ExitCodes.ALLOWED ? 'ran' : 'ran'; // Either way, we ran it.
  }

  // --- Final sign-off ---
  if (options.json) {
    process.stdout.write(JSON.stringify(result) + '\n');
    return ExitCodes.ALLOWED;
  }

  process.stdout.write('\n');
  process.stdout.write(`  ${kleur.green().bold("You're now protected.")}\n`);
  process.stdout.write('\n');
  process.stdout.write(kleur.dim('  Next steps:\n'));
  process.stdout.write(
    kleur.dim('    • Commit normally — risky changes will be flagged.\n'),
  );
  process.stdout.write(
    kleur.dim('    • Run `reentry observe` to see live agent activity.\n'),
  );
  process.stdout.write(
    kleur.dim(
      '    • Invite your team: open the dashboard and share the team URL.\n',
    ),
  );
  process.stdout.write('\n');

  return ExitCodes.ALLOWED;
}
