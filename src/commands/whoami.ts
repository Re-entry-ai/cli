import kleur from 'kleur';
import { ExitCodes } from '../lib/exit-codes';
import { readCredentials } from '../lib/storage';
import { apiCall, ApiNetworkError } from '../lib/api';

interface WhoamiOptions {
  json?: boolean;
}

interface WhoamiResponse {
  team: { id: string; name: string };
  agentId: string;
  tokenName: string;
  scopes: string[];
  planTier: string;
}

export async function whoamiCommand(options: WhoamiOptions): Promise<number> {
  const creds = readCredentials();
  if (!creds) {
    if (options.json) {
      process.stdout.write(JSON.stringify({ authenticated: false }) + '\n');
    } else {
      process.stderr.write(
        `${kleur.red('error:')} Not logged in. Run \`reentry login\`.\n`,
      );
    }
    return ExitCodes.AUTH;
  }

  try {
    const result = await apiCall<WhoamiResponse>('/mcp/whoami', {
      token: creds.accessToken,
    });

    if (result.status === 401) {
      if (options.json) {
        process.stdout.write(
          JSON.stringify({ authenticated: false, reason: 'token_invalid' }) + '\n',
        );
      } else {
        process.stderr.write(
          `${kleur.red('error:')} Token rejected — it may have been revoked or expired. Run \`reentry login\`.\n`,
        );
      }
      return ExitCodes.AUTH;
    }

    if (!result.ok) {
      process.stderr.write(
        `${kleur.red('error:')} Backend returned HTTP ${result.status}.\n`,
      );
      return ExitCodes.NETWORK;
    }

    if (options.json) {
      process.stdout.write(JSON.stringify(result.body) + '\n');
      return ExitCodes.ALLOWED;
    }

    const w = result.body;
    process.stdout.write('\n');
    process.stdout.write(`  Team:      ${kleur.bold(w.team.name)} ${kleur.dim(`(${w.team.id})`)}\n`);
    process.stdout.write(`  Agent:     ${w.agentId}\n`);
    process.stdout.write(`  Token:     ${w.tokenName}\n`);
    process.stdout.write(`  Plan:      ${w.planTier}\n`);
    process.stdout.write(`  Scopes:    ${w.scopes.join(', ')}\n`);
    process.stdout.write('\n');

    return ExitCodes.ALLOWED;
  } catch (err) {
    if (err instanceof ApiNetworkError) {
      process.stderr.write(`${kleur.red('error:')} ${err.message}\n`);
      return ExitCodes.NETWORK;
    }
    const message = err instanceof Error ? err.message : 'unknown';
    process.stderr.write(`${kleur.red('error:')} ${message}\n`);
    return ExitCodes.INTERNAL;
  }
}
