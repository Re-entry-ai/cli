import kleur from 'kleur';
import { ExitCodes, ExitCode } from '../lib/exit-codes';
import { readCredentials } from '../lib/storage';
import { readCurrentBranch } from '../lib/git';
import { callMcpTool } from '../lib/mcp-client';
import { handleMcpError } from './pre-commit';

interface StatusOptions {
  json?: boolean;
  repository?: string;
}

interface DecideActionResponse {
  decision: 'allowed' | 'blocked' | 'requires_human';
  riskScore: number;
  riskLevel: string;
  violations: Array<{
    policyId: string;
    policyName: string;
    description: string;
  }>;
  remediation: string[];
  explanation: string;
  decidedAt: string;
}

function exitCodeForDecision(
  decision: DecideActionResponse['decision'],
): ExitCode {
  if (decision === 'blocked') {
    return ExitCodes.BLOCKED;
  }
  if (decision === 'requires_human') {
    return ExitCodes.REQUIRES_HUMAN;
  }
  return ExitCodes.ALLOWED;
}

export async function statusCommand(
  prNumber: string | undefined,
  options: StatusOptions,
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
      `${kleur.red('error:')} --repository <owner/name> is required for now.\n`,
    );
    return ExitCodes.USAGE;
  }

  const args: Record<string, unknown> = { repository: options.repository };
  if (prNumber) {
    const parsed = Number(prNumber);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      process.stderr.write(
        `${kleur.red('error:')} PR number must be a positive integer.\n`,
      );
      return ExitCodes.USAGE;
    }
    args.prNumber = parsed;
  } else {
    const branch = readCurrentBranch();
    if (branch) {
      args.branch = branch;
    }
  }

  try {
    const result = await callMcpTool<DecideActionResponse>(
      'decide_action',
      args,
      creds.accessToken,
    );

    const exit = exitCodeForDecision(result.decision);

    if (options.json) {
      process.stdout.write(JSON.stringify(result) + '\n');
      return exit;
    }

    renderStatus(result, exit);
    return exit;
  } catch (err) {
    return handleMcpError(err, 'status');
  }
}

function renderStatus(result: DecideActionResponse, exit: ExitCode): void {
  const decisionLabel = (() => {
    if (exit === ExitCodes.BLOCKED) {
      return kleur.red().bold('BLOCKED');
    }
    if (exit === ExitCodes.REQUIRES_HUMAN) {
      return kleur.yellow().bold('REQUIRES HUMAN');
    }
    return kleur.green().bold('ALLOWED');
  })();

  process.stdout.write('\n');
  process.stdout.write(
    `  Decision: ${decisionLabel} ${kleur.dim(`(${result.riskLevel}, score ${result.riskScore}/100)`)}\n`,
  );
  process.stdout.write(`  ${result.explanation}\n`);
  process.stdout.write('\n');

  if (result.violations.length > 0) {
    process.stdout.write('  Policy violations:\n');
    for (const v of result.violations) {
      process.stdout.write(`    • ${v.policyName}: ${v.description}\n`);
    }
    process.stdout.write('\n');
  }

  if (result.remediation.length > 0) {
    process.stdout.write('  Remediation:\n');
    for (const r of result.remediation) {
      process.stdout.write(`    • ${r}\n`);
    }
    process.stdout.write('\n');
  }
}
