import kleur from 'kleur';
import { ExitCodes } from '../lib/exit-codes';
import { removePreCommitHook } from '../lib/git-hook';
import { credentialsPath } from '../lib/config';

interface DisableOptions {
  json?: boolean;
}

interface DisableJsonPayload {
  success: boolean;
  hook: {
    outcome: 'removed' | 'restored_backup' | 'absent' | 'foreign_hook' | 'not_a_repo';
    path?: string;
    backup?: string;
  };
  hint?: string;
}

/**
 * `reentry disable` — the counterpart to `reentry init`.
 *
 * Removes the pre-commit hook installed by `reentry init`. If we backed
 * up a previous custom hook at `.git/hooks/pre-commit.reentry-backup`,
 * restore it. The credentials file is left alone — `reentry logout` is
 * the right tool to remove that.
 *
 * Refuses to touch a foreign pre-commit hook (one without our marker
 * line). Anything we didn't install is somebody else's to manage.
 */
export async function disableCommand(
  options: DisableOptions,
): Promise<number> {
  const result = removePreCommitHook();

  const credsHint = `Credentials at ${credentialsPath()} were NOT removed. Run \`reentry logout\` to revoke + delete them.`;

  if (options.json) {
    const payload: DisableJsonPayload = {
      success: result.kind !== 'foreign_hook' && result.kind !== 'not_a_repo',
      hook: { outcome: result.kind },
      hint: credsHint,
    };
    if ('path' in result) {
      payload.hook.path = result.path;
    }
    if ('backup' in result) {
      payload.hook.backup = result.backup;
    }
    process.stdout.write(JSON.stringify(payload) + '\n');
  } else {
    process.stdout.write('\n');
    if (result.kind === 'removed') {
      process.stdout.write(
        `  ${kleur.green('✓')} Removed pre-commit hook at ${kleur.dim(result.path)}\n`,
      );
    } else if (result.kind === 'restored_backup') {
      process.stdout.write(
        `  ${kleur.green('✓')} Restored your previous pre-commit hook\n` +
          `    ${kleur.dim(`(backup ${result.backup} restored to ${result.path})`)}\n`,
      );
    } else if (result.kind === 'absent') {
      process.stdout.write(
        `  ${kleur.dim('·')} No pre-commit hook installed. Nothing to remove.\n`,
      );
    } else if (result.kind === 'foreign_hook') {
      process.stdout.write(
        `  ${kleur.yellow('⚠')} Pre-commit hook at ${kleur.dim(result.path)} is not managed by reentry-cli.\n` +
          `    ${kleur.dim('Refusing to delete somebody else\'s hook. Remove it manually if you want it gone.')}\n`,
      );
    } else if (result.kind === 'not_a_repo') {
      process.stdout.write(
        `  ${kleur.yellow('⚠')} Not inside a git repository — nothing to remove here.\n`,
      );
    }
    process.stdout.write(`\n  ${kleur.dim(credsHint)}\n\n`);
  }

  if (result.kind === 'foreign_hook') {
    return ExitCodes.USAGE;
  }
  if (result.kind === 'not_a_repo') {
    return ExitCodes.USAGE;
  }
  return ExitCodes.ALLOWED;
}
