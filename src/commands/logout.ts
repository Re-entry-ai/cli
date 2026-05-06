import kleur from 'kleur';
import { ExitCodes } from '../lib/exit-codes';
import { deleteCredentials } from '../lib/storage';

interface LogoutOptions {
  json?: boolean;
}

export function logoutCommand(options: LogoutOptions): number {
  try {
    const removed = deleteCredentials();

    if (options.json) {
      process.stdout.write(JSON.stringify({ ok: true, removed }) + '\n');
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
    return ExitCodes.ALLOWED;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown';
    process.stderr.write(`${kleur.red('error:')} ${message}\n`);
    return ExitCodes.INTERNAL;
  }
}
