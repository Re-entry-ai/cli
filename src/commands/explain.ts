import kleur from 'kleur';
import { ExitCodes } from '../lib/exit-codes';
import { readCredentials } from '../lib/storage';
import { callMcpTool } from '../lib/mcp-client';
import { handleMcpError } from './pre-commit';

interface ExplainOptions {
  json?: boolean;
  repository?: string;
}

interface ExplainResponse {
  humanReadable: string;
  structured: {
    riskScore?: number;
    riskLevel?: string;
    factors: Array<{ name: string; score: number; description: string }>;
    policiesEvaluated: number;
    policiesMatched: number;
    decision?: string;
    interventionStatus?: string;
  };
  explainedAt: string;
}

export async function explainCommand(
  prNumberArg: string | undefined,
  options: ExplainOptions,
): Promise<number> {
  const creds = readCredentials();
  if (!creds) {
    process.stderr.write(
      `${kleur.red('error:')} Not logged in. Run \`reentry login\`.\n`,
    );
    return ExitCodes.AUTH;
  }

  if (!options.repository) {
    process.stderr.write(
      `${kleur.red('error:')} --repository <owner/name> is required.\n`,
    );
    return ExitCodes.USAGE;
  }

  if (!prNumberArg) {
    process.stderr.write(`${kleur.red('error:')} PR number is required.\n`);
    return ExitCodes.USAGE;
  }
  const prNumber = Number(prNumberArg);
  if (!Number.isFinite(prNumber) || prNumber <= 0) {
    process.stderr.write(
      `${kleur.red('error:')} PR number must be a positive integer.\n`,
    );
    return ExitCodes.USAGE;
  }

  try {
    const result = await callMcpTool<ExplainResponse>(
      'explain_decision',
      { repository: options.repository, prNumber },
      creds.accessToken,
    );

    if (options.json) {
      process.stdout.write(JSON.stringify(result) + '\n');
      return ExitCodes.ALLOWED;
    }

    process.stdout.write('\n');
    process.stdout.write(`  ${result.humanReadable}\n`);
    process.stdout.write('\n');

    const factors = result.structured.factors;
    if (factors.length > 0) {
      process.stdout.write('  Top risk factors:\n');
      for (const f of factors.slice(0, 5)) {
        process.stdout.write(
          `    • ${kleur.bold(f.name)} ${kleur.dim(`(${f.score})`)}: ${f.description}\n`,
        );
      }
      process.stdout.write('\n');
    }

    return ExitCodes.ALLOWED;
  } catch (err) {
    return handleMcpError(err, 'explain');
  }
}
