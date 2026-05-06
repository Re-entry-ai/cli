import kleur from 'kleur';
import { ExitCodes } from '../lib/exit-codes';
import { readCredentials } from '../lib/storage';
import { callMcpTool } from '../lib/mcp-client';
import { handleMcpError } from './pre-commit';

interface LogOptions {
  json?: boolean;
  limit?: string;
  offset?: string;
  repository?: string;
  kind?: string;
}

interface AssessmentItem {
  type: 'pr' | 'push';
  assessmentId: string;
  repository: string;
  branch?: string;
  prNumber?: number;
  prTitle?: string;
  riskScore: number;
  riskLevel: string;
  summary: string;
  analyzedAt: string;
}

interface LogResponse {
  items: AssessmentItem[];
  total: number;
  limit: number;
  offset: number;
}

function emitUsage(message: string, options: LogOptions): void {
  if (options.json) {
    process.stdout.write(
      JSON.stringify({ success: false, code: 'USAGE', message }) + '\n',
    );
    return;
  }
  process.stderr.write(`${kleur.red('error:')} ${message}\n`);
}

export async function logCommand(options: LogOptions): Promise<number> {
  const creds = readCredentials();
  if (!creds) {
    if (options.json) {
      process.stdout.write(
        JSON.stringify({
          success: false,
          code: 'AUTH',
          message: 'Not logged in. Run `reentry login`.',
        }) + '\n',
      );
    } else {
      process.stderr.write(
        `${kleur.red('error:')} Not logged in. Run \`reentry login\`.\n`,
      );
    }
    return ExitCodes.AUTH;
  }

  // Validate options.
  const limitParsed = options.limit !== undefined ? Number(options.limit) : 20;
  if (!Number.isFinite(limitParsed) || limitParsed < 1 || limitParsed > 100) {
    emitUsage('--limit must be an integer in 1..100.', options);
    return ExitCodes.USAGE;
  }
  const offsetParsed =
    options.offset !== undefined ? Number(options.offset) : 0;
  if (!Number.isFinite(offsetParsed) || offsetParsed < 0) {
    emitUsage('--offset must be a non-negative integer.', options);
    return ExitCodes.USAGE;
  }
  const validKinds = new Set(['pr', 'push', 'both']);
  const kind = options.kind ?? 'both';
  if (!validKinds.has(kind)) {
    emitUsage('--kind must be one of: pr, push, both.', options);
    return ExitCodes.USAGE;
  }

  const args: Record<string, unknown> = {
    limit: Math.floor(limitParsed),
    offset: Math.floor(offsetParsed),
    kind,
  };
  if (options.repository) {
    args.repository = options.repository;
  }

  try {
    const result = await callMcpTool<LogResponse>(
      'list_recent_assessments',
      args,
      creds.accessToken,
    );

    if (options.json) {
      process.stdout.write(JSON.stringify(result) + '\n');
      return ExitCodes.ALLOWED;
    }

    renderLog(result);
    return ExitCodes.ALLOWED;
  } catch (err) {
    return handleMcpError(err, 'fetch assessment log', {
      json: options.json,
    });
  }
}

function renderLog(log: LogResponse): void {
  const colorFor = (level: string): ((s: string) => string) => {
    const k = level.toLowerCase();
    if (k === 'critical') {
      return kleur.red().bold;
    }
    if (k === 'high') {
      return kleur.yellow().bold;
    }
    if (k === 'medium') {
      return kleur.yellow;
    }
    return kleur.green;
  };

  process.stdout.write('\n');
  if (log.items.length === 0) {
    process.stdout.write(
      `  ${kleur.dim('No assessments found for the current filter.')}\n\n`,
    );
    return;
  }

  process.stdout.write(
    `  ${kleur.bold(
      `Recent assessments`,
    )} ${kleur.dim(`(${log.items.length} of ${log.total})`)}\n\n`,
  );

  for (const item of log.items) {
    // Defensive against partial responses — server might add new fields
    // or rename existing ones without a CLI bump.
    const time = item.analyzedAt
      ? new Date(item.analyzedAt).toLocaleString()
      : '(unknown time)';
    const repo =
      typeof item.repository === 'string' ? item.repository : '(unknown)';
    const score = typeof item.riskScore === 'number' ? item.riskScore : 0;
    const level = typeof item.riskLevel === 'string' ? item.riskLevel : 'unknown';
    const tag =
      item.type === 'pr'
        ? `PR #${item.prNumber ?? '?'}`
        : `push ${item.branch || ''}`;
    const title =
      item.type === 'pr' ? item.prTitle || '' : item.summary || '';
    process.stdout.write(
      `  ${colorFor(level)(
        `${score.toString().padStart(3, ' ')}/100`,
      )} ${kleur.dim(time)}  ${kleur.bold(repo)} ${kleur.dim(tag)}\n`,
    );
    if (title) {
      process.stdout.write(
        `      ${kleur.dim(title.length > 100 ? title.slice(0, 100) + '…' : title)}\n`,
      );
    }
  }
  process.stdout.write('\n');
  if (log.offset + log.items.length < log.total) {
    process.stdout.write(
      `  ${kleur.dim(
        `(${log.total - log.offset - log.items.length} more — use --offset ${log.offset + log.items.length})`,
      )}\n\n`,
    );
  }
}
