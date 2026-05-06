import { Command } from 'commander';
import kleur from 'kleur';
import { CLI_VERSION } from './lib/config';
import { ExitCodes } from './lib/exit-codes';
import { loginCommand } from './commands/login';
import { logoutCommand } from './commands/logout';
import { whoamiCommand } from './commands/whoami';
import { preCommitCommand } from './commands/pre-commit';
import { statusCommand } from './commands/status';
import { explainCommand } from './commands/explain';
import { observeCommand } from './commands/observe';
import { initCommand } from './commands/init';

/**
 * `reentry` CLI entry point.
 *
 * The whole binary is a thin commander harness. Each subcommand is a single
 * function that returns an ExitCode. We never `process.exit` from the
 * subcommand body — we let the harness exit cleanly so tests can run the
 * commands in-process without aborting the test runner.
 */
function main(argv: string[]): void {
  // Honor NO_COLOR (terminal hygiene) without explicit option flags.
  if (process.env.NO_COLOR) {
    kleur.enabled = false;
  }

  const program = new Command();

  program
    .name('reentry')
    .description('Governance for autonomous coding agents, in your terminal.')
    .version(CLI_VERSION, '-v, --version', 'print the CLI version')
    .option('--no-color', 'disable colored output')
    .hook('preAction', (cmd) => {
      const opts = cmd.opts<{ color?: boolean }>();
      if (opts.color === false) {
        kleur.enabled = false;
      }
    });

  program
    .command('init')
    .description(
      'Set up re-entry: log in via device flow, install the git pre-commit hook, run a first check.',
    )
    .option('--json', 'machine-readable output')
    .option('--skip-login', 'skip the login step (assume already authenticated)')
    .option('--skip-hook', 'skip git pre-commit hook install')
    .option('--skip-first-check', 'skip the first pre-commit run')
    .action(
      async (options: {
        json?: boolean;
        skipLogin?: boolean;
        skipHook?: boolean;
        skipFirstCheck?: boolean;
      }) => {
        const code = await initCommand({
          json: options.json,
          skipLogin: options.skipLogin,
          skipHook: options.skipHook,
          skipFirstCheck: options.skipFirstCheck,
        });
        process.exit(code);
      },
    );

  program
    .command('login')
    .description('Authenticate the CLI via device flow.')
    .option('--json', 'machine-readable output (prints device codes; does not poll)')
    .action(async (options: { json?: boolean }) => {
      const code = await loginCommand({ json: options.json });
      process.exit(code);
    });

  program
    .command('logout')
    .description('Remove locally stored credentials.')
    .option('--json', 'machine-readable output')
    .action((options: { json?: boolean }) => {
      const code = logoutCommand({ json: options.json });
      process.exit(code);
    });

  program
    .command('whoami')
    .description('Show the team and agent identity for the stored token.')
    .option('--json', 'machine-readable output')
    .action(async (options: { json?: boolean }) => {
      const code = await whoamiCommand({ json: options.json });
      process.exit(code);
    });

  program
    .command('pre-commit')
    .description(
      'Check the staged diff against team policies. Designed to be wired up as a git pre-commit hook.',
    )
    .option('--json', 'machine-readable output')
    .action(async (options: { json?: boolean }) => {
      const code = await preCommitCommand({ json: options.json });
      process.exit(code);
    });

  program
    .command('status [prNumber]')
    .description('Get the governance verdict for the current branch or a specific PR.')
    .option('--json', 'machine-readable output')
    .option('--repository <owner/name>', 'repository identifier (required)')
    .action(
      async (
        prNumber: string | undefined,
        options: { json?: boolean; repository?: string },
      ) => {
        const code = await statusCommand(prNumber, {
          json: options.json,
          repository: options.repository,
        });
        process.exit(code);
      },
    );

  program
    .command('observe')
    .description('Tail live agent-session events from your team in this terminal.')
    .option('--json', 'machine-readable output (one JSON object per line)')
    .action(async (options: { json?: boolean }) => {
      const code = await observeCommand({ json: options.json });
      process.exit(code);
    });

  program
    .command('explain <prNumber>')
    .description('Print the human-readable rationale for a PR decision.')
    .option('--json', 'machine-readable output')
    .option('--repository <owner/name>', 'repository identifier (required)')
    .action(
      async (
        prNumber: string,
        options: { json?: boolean; repository?: string },
      ) => {
        const code = await explainCommand(prNumber, {
          json: options.json,
          repository: options.repository,
        });
        process.exit(code);
      },
    );

  program.exitOverride((err) => {
    // Commander's default exits with code 1 on usage errors. Map to 64 (USAGE)
    // so CI scripts can branch reliably.
    if (err.code === 'commander.helpDisplayed' || err.code === 'commander.version') {
      process.exit(ExitCodes.ALLOWED);
    }
    process.exit(ExitCodes.USAGE);
  });

  program.parseAsync(argv).catch((err: Error) => {
    process.stderr.write(`${kleur.red('error:')} ${err.message}\n`);
    process.exit(ExitCodes.INTERNAL);
  });
}

main(process.argv);
