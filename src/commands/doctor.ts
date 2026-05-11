import * as fs from 'fs';
import * as path from 'path';
import kleur from 'kleur';
import { ExitCodes } from '../lib/exit-codes';
import { apiUrl, credentialsPath, CLI_VERSION } from '../lib/config';
import { readCredentials } from '../lib/storage';
import { callMcpTool } from '../lib/mcp-client';
import { probePreCommitHook } from '../lib/git-hook';
import {
  claudeCodeConfigPath,
  statusClaudeCode,
} from '../lib/agent-configs/claude-code';
import {
  cursorConfigPath,
  statusCursor,
} from '../lib/agent-configs/cursor';

interface DoctorOptions {
  json?: boolean;
}

type CheckStatus = 'ok' | 'warn' | 'fail' | 'skip';

interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
}

async function checkCredentials(
  options: DoctorOptions,
): Promise<{ result: CheckResult; creds: ReturnType<typeof readCredentials> }> {
  const creds = readCredentials();
  if (!creds) {
    return {
      result: {
        name: 'credentials',
        status: 'fail',
        detail:
          'No credentials found. Run `reentry login` to authenticate.',
      },
      creds,
    };
  }

  // Mode-check the credentials file — anything other than 0600 is a leak.
  const credsFile = credentialsPath();
  let perms: number | null = null;
  try {
    perms = fs.statSync(credsFile).mode & 0o777;
  } catch {
    perms = null;
  }
  if (perms !== null && perms !== 0o600) {
    return {
      result: {
        name: 'credentials',
        status: 'warn',
        detail: `Credentials file at ${path.basename(credsFile)} is mode 0${perms.toString(8)} (expected 0600). Run \`chmod 600 ${credsFile}\`.`,
      },
      creds,
    };
  }

  return {
    result: {
      name: 'credentials',
      status: 'ok',
      detail: `Token issued ${creds.issuedAt} — file mode 0600.`,
    },
    creds,
  };
}

async function checkBackendReachable(
  creds: ReturnType<typeof readCredentials>,
  options: DoctorOptions,
): Promise<CheckResult> {
  if (!creds) {
    return {
      name: 'backend',
      status: 'skip',
      detail: 'Skipped — not logged in.',
    };
  }
  try {
    // `get_team_rules` is a cheap read that exercises auth + tier + scope
    // gates without hitting the LLM. A successful call confirms the
    // token still validates and the backend route is up.
    await callMcpTool('get_team_rules', {}, creds.accessToken);
    return {
      name: 'backend',
      status: 'ok',
      detail: `Reachable at ${apiUrl()}; token valid.`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      name: 'backend',
      status: 'fail',
      detail: `Could not reach backend or token rejected: ${message}`,
    };
  }
}

function checkGitHook(options: DoctorOptions): CheckResult {
  const probe = probePreCommitHook();
  if (!probe.inRepo) {
    return {
      name: 'pre-commit hook',
      status: 'skip',
      detail: 'Not inside a git repository — nothing to install here.',
    };
  }
  if (!probe.exists) {
    return {
      name: 'pre-commit hook',
      status: 'warn',
      detail:
        'No pre-commit hook installed. Run `reentry init` to enable governance on every commit.',
    };
  }
  if (!probe.managedByReentry) {
    return {
      name: 'pre-commit hook',
      status: 'warn',
      detail: `Existing pre-commit hook at ${probe.path} is not managed by reentry. \`reentry init\` will back it up before installing.`,
    };
  }
  return {
    name: 'pre-commit hook',
    status: 'ok',
    detail: `Managed shim installed at ${probe.path}.`,
  };
}

function checkAgentConfig(
  agent: 'claude-code' | 'cursor',
  options: DoctorOptions,
): CheckResult {
  const status =
    agent === 'claude-code'
      ? statusClaudeCode({ global: false })
      : statusCursor({ global: false });

  const configPath =
    agent === 'claude-code'
      ? claudeCodeConfigPath(false)
      : cursorConfigPath(false);

  if (!status.installed) {
    return {
      name: `agent: ${agent}`,
      status: 'skip',
      detail: `No project-local entry. Run \`reentry agent add ${agent}\` to register the MCP server.`,
    };
  }

  // The agent config holds the bearer token — verify file mode 0600.
  let perms: number | null = null;
  try {
    perms = fs.statSync(configPath).mode & 0o777;
  } catch {
    perms = null;
  }
  if (perms !== null && perms !== 0o600) {
    return {
      name: `agent: ${agent}`,
      status: 'warn',
      detail: `Installed at ${configPath} but file mode is 0${perms.toString(8)} (expected 0600). Run \`chmod 600 ${configPath}\`.`,
    };
  }
  return {
    name: `agent: ${agent}`,
    status: 'ok',
    detail: `Installed at ${configPath} — file mode 0600.`,
  };
}

const STATUS_ICON: Record<CheckStatus, string> = {
  ok: kleur.green('✓'),
  warn: kleur.yellow('⚠'),
  fail: kleur.red('✗'),
  skip: kleur.dim('·'),
};

function renderChecks(checks: CheckResult[]): void {
  process.stdout.write('\n');
  for (const check of checks) {
    process.stdout.write(
      `  ${STATUS_ICON[check.status]} ${kleur.bold(check.name)}\n` +
        `    ${kleur.dim(check.detail)}\n`,
    );
  }
  process.stdout.write('\n');
}

function summaryExitCode(checks: CheckResult[]): number {
  const hasFail = checks.some((check) => check.status === 'fail');
  return hasFail ? ExitCodes.INTERNAL : ExitCodes.ALLOWED;
}

/**
 * `reentry doctor` — diagnostic command.
 *
 * Reports on every piece of state `reentry` depends on: credentials,
 * backend reachability, git hook, IDE agent configs, CLI version. Designed
 * for a CI step (`reentry doctor --json | jq '.checks[] | select(.status=="fail")'`)
 * as well as for interactive use.
 *
 * Never modifies state — pure read.
 */
export async function doctorCommand(options: DoctorOptions): Promise<number> {
  const checks: CheckResult[] = [];

  const credsCheck = await checkCredentials(options);
  checks.push(credsCheck.result);
  checks.push(await checkBackendReachable(credsCheck.creds, options));
  checks.push(checkGitHook(options));
  checks.push(checkAgentConfig('claude-code', options));
  checks.push(checkAgentConfig('cursor', options));
  checks.push({
    name: 'cli version',
    status: 'ok',
    detail: `reentry-cli ${CLI_VERSION}`,
  });

  if (options.json) {
    process.stdout.write(
      JSON.stringify({
        success: !checks.some((check) => check.status === 'fail'),
        version: CLI_VERSION,
        apiUrl: apiUrl(),
        checks,
      }) + '\n',
    );
  } else {
    renderChecks(checks);
  }

  return summaryExitCode(checks);
}
