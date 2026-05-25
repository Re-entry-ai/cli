import kleur from 'kleur';
import { ExitCodes } from '../lib/exit-codes';
import { deleteCredentials } from '../lib/storage';
import { statusClaudeCode } from '../lib/agent-configs/claude-code';
import { statusCursor } from '../lib/agent-configs/cursor';

interface LogoutOptions {
  json?: boolean;
}

/** Returns names of IDE agents that still have our MCP token wired after logout. */
function findLingeringAgents(): string[] {
  const lingering: string[] = [];

  try {
    if (
      statusClaudeCode({ global: true }).installed ||
      statusClaudeCode({ global: false }).installed
    ) {
      lingering.push('claude-code');
    }
  } catch {
    // Config file unreadable — not our problem.
  }

  try {
    if (
      statusCursor({ global: true }).installed ||
      statusCursor({ global: false }).installed
    ) {
      lingering.push('cursor');
    }
  } catch {
    // Config file unreadable — not our problem.
  }

  return lingering;
}

export function logoutCommand(options: LogoutOptions): number {
  try {
    const removed = deleteCredentials();
    const lingering = findLingeringAgents();

    if (options.json) {
      process.stdout.write(
        JSON.stringify({ ok: true, removed, agentsStillWired: lingering }) + '\n',
      );
      return ExitCodes.ALLOWED;
    }

    if (removed) {
      process.stdout.write(`${kleur.green('✓')} Logged out.\n`);
      process.stdout.write(
        kleur.dim(
          '  Note: this only removes the local token. ' +
            'Revoke server-side from the dashboard to fully invalidate.\n',
        ),
      );
    } else {
      process.stdout.write(kleur.dim('No active session — nothing to do.\n'));
    }

    if (lingering.length > 0) {
      process.stdout.write('\n');
      process.stdout.write(
        `  ${kleur.yellow('!')} Your token is still wired in: ${kleur.bold(lingering.join(', '))}\n`,
      );
      for (const agent of lingering) {
        process.stdout.write(
          kleur.dim(`    reentry agent remove ${agent}\n`),
        );
      }
    }

    return ExitCodes.ALLOWED;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown';
    process.stderr.write(`${kleur.red('error:')} ${message}\n`);
    return ExitCodes.INTERNAL;
  }
}
