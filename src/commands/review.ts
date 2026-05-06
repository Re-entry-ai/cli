import kleur from 'kleur';
import { ExitCodes } from '../lib/exit-codes';
import { readCredentials } from '../lib/storage';
import { readRemoteOriginUrl } from '../lib/git';
import { callMcpTool } from '../lib/mcp-client';
import { handleMcpError } from './pre-commit';
import { safeText } from '../lib/safe-print';

interface ReviewOptions {
  json?: boolean;
  repository?: string;
}

interface InlineComment {
  path: string;
  line: number;
  body: string;
  severity: 'info' | 'warning' | 'critical';
}

interface PrCodeReviewResponse {
  prId: string;
  repository: string;
  prNumber: number;
  prTitle: string;
  prAuthor: string;
  branch: string;
  riskScore: number;
  riskLevel: string;
  summary: string;
  aiSummary?: string;
  aiKeyFindings?: string[];
  aiSuggestions?: string[];
  aiReviewFocus?: string;
  inlineComments?: InlineComment[];
  crossFileFindings?: string[];
  aiAgentInstructions?: string;
  assessedAt: string;
  dashboardUrl: string;
}

function emitUsage(message: string, options: ReviewOptions): void {
  if (options.json) {
    process.stdout.write(
      JSON.stringify({ success: false, code: 'USAGE', message }) + '\n',
    );
    return;
  }
  process.stderr.write(`${kleur.red('error:')} ${message}\n`);
}

export async function reviewCommand(
  prNumberArg: string,
  options: ReviewOptions,
): Promise<number> {
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

  const repository = options.repository ?? readRemoteOriginUrl();
  if (!repository) {
    emitUsage(
      '--repository <owner/name> is required (or run inside a git repo with a github.com origin remote).',
      options,
    );
    return ExitCodes.USAGE;
  }

  const prNumber = Number(prNumberArg);
  if (!Number.isFinite(prNumber) || prNumber <= 0) {
    emitUsage('PR number must be a positive integer.', options);
    return ExitCodes.USAGE;
  }

  try {
    const result = await callMcpTool<PrCodeReviewResponse>(
      'get_pr_code_review',
      { repository, prNumber },
      creds.accessToken,
    );

    if (options.json) {
      process.stdout.write(JSON.stringify(result) + '\n');
      return ExitCodes.ALLOWED;
    }

    renderReview(result);
    return ExitCodes.ALLOWED;
  } catch (err) {
    return handleMcpError(err, 'fetch PR review', { json: options.json });
  }
}

function renderReview(review: PrCodeReviewResponse): void {
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
  const severityBadge = (severity: string): string => {
    if (severity === 'critical') {
      return kleur.red().bold(' CRIT  ');
    }
    if (severity === 'warning') {
      return kleur.yellow().bold(' WARN  ');
    }
    return kleur.cyan(' info  ');
  };

  // All MCP-derived strings flow through `safeText` before printing.
  // Threat: LLM output may include ANSI escapes / control characters
  // injected from the diff content. See lib/safe-print.ts.
  const safeLevel = safeText(review.riskLevel || 'unknown');
  const safeTitle = safeText(review.prTitle);
  const safeRepo = safeText(review.repository);
  const safeBranch = safeText(review.branch);
  const safeAuthor = safeText(review.prAuthor);

  process.stdout.write('\n');
  process.stdout.write(
    `  ${colorFor(safeLevel)(safeLevel.toUpperCase())} ${kleur.dim(
      `(score ${review.riskScore}/100)`,
    )}  ${kleur.bold(safeTitle)}\n`,
  );
  process.stdout.write(
    `  ${kleur.dim(`#${review.prNumber} on ${safeRepo} · ${safeBranch} · @${safeAuthor}`)}\n`,
  );
  process.stdout.write('\n');

  if (review.aiSummary) {
    process.stdout.write(`  ${safeText(review.aiSummary)}\n`);
    process.stdout.write('\n');
  } else if (review.summary) {
    process.stdout.write(`  ${kleur.dim(safeText(review.summary))}\n\n`);
  }

  if (review.aiReviewFocus) {
    process.stdout.write(
      `  ${kleur.bold('Verify:')} ${safeText(review.aiReviewFocus)}\n\n`,
    );
  }

  if (review.inlineComments && review.inlineComments.length > 0) {
    process.stdout.write(`  ${kleur.bold('Code findings:')}\n`);
    for (const comment of review.inlineComments) {
      // Defensive against partial/null shapes from MCP — `body` may be
      // empty if the LLM returned an inline-comment without a quote/fix
      // string. Don't crash on .split() of undefined.
      const path = safeText(
        typeof comment.path === 'string' ? comment.path : '?',
      );
      const line = typeof comment.line === 'number' ? comment.line : 0;
      const severity =
        comment.severity === 'critical' || comment.severity === 'warning'
          ? comment.severity
          : 'info';
      const body = safeText(
        typeof comment.body === 'string' ? comment.body : '',
      );
      process.stdout.write(
        `    ${severityBadge(severity)} ${kleur.dim(`${path}:L${line}`)}\n`,
      );
      const bodyLines = body.split('\n').slice(0, 6);
      for (const lineText of bodyLines) {
        process.stdout.write(`           ${lineText}\n`);
      }
    }
    process.stdout.write('\n');
  }

  const sanitizedStringList = (rawValue: unknown): string[] =>
    Array.isArray(rawValue)
      ? rawValue
          .filter(
            (entry): entry is string => typeof entry === 'string',
          )
          .map((entry) => safeText(entry))
      : [];
  const keyFindings = sanitizedStringList(review.aiKeyFindings);
  const suggestions = sanitizedStringList(review.aiSuggestions);
  const crossFileFindings = sanitizedStringList(review.crossFileFindings);

  if (keyFindings.length > 0) {
    process.stdout.write(`  ${kleur.bold('Focus / code notes:')}\n`);
    for (const finding of keyFindings) {
      process.stdout.write(`    ${kleur.dim('│')} ${finding}\n`);
    }
    process.stdout.write('\n');
  }

  if (suggestions.length > 0) {
    process.stdout.write(`  ${kleur.bold('Suggestions:')}\n`);
    for (const suggestion of suggestions) {
      process.stdout.write(`    ${kleur.green('+')} ${suggestion}\n`);
    }
    process.stdout.write('\n');
  }

  if (crossFileFindings.length > 0) {
    process.stdout.write(`  ${kleur.bold('Cross-file findings:')}\n`);
    for (const finding of crossFileFindings) {
      process.stdout.write(`    ${kleur.cyan('•')} ${finding}\n`);
    }
    process.stdout.write('\n');
  }

  process.stdout.write(
    `  ${kleur.dim(`Dashboard: ${review.dashboardUrl}`)}\n\n`,
  );
}
