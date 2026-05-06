import kleur from 'kleur';
import clipboardy from 'clipboardy';
import ora from 'ora';
import { openBrowser } from '../lib/browser';
import { ExitCodes } from '../lib/exit-codes';
import { apiUrl } from '../lib/config';
import { writeCredentials } from '../lib/storage';
import { ApiNetworkError } from '../lib/api';
import { pollOnce, requestDeviceCode, sleep } from '../auth/device-flow';

interface LoginOptions {
  json?: boolean;
}

export async function loginCommand(options: LoginOptions): Promise<number> {
  try {
    const code = await requestDeviceCode();

    if (options.json) {
      // Machine-readable mode: print the codes, do NOT poll. CI scripts that
      // need to integrate device flow will drive the polling themselves.
      process.stdout.write(JSON.stringify(code) + '\n');
      return ExitCodes.ALLOWED;
    }

    process.stdout.write('\n');
    process.stdout.write(`  Your one-time code: ${kleur.bold().cyan(code.user_code)}\n`);
    process.stdout.write('\n');
    process.stdout.write(`  Opening ${kleur.dim(code.verification_uri)} ...\n`);

    let clipboardCopied = false;
    try {
      clipboardy.writeSync(code.user_code);
      clipboardCopied = true;
    } catch {
      // Clipboard isn't available (headless / no DISPLAY). Not fatal.
    }
    if (clipboardCopied) {
      process.stdout.write(kleur.dim('  (code copied to clipboard)\n'));
    }

    let browserOpened = false;
    // REENTRY_SKIP_BROWSER lets tests + headless workflows opt out of the
    // browser pop. The CLI still prints the URL for manual paste.
    const skipBrowser = process.env.REENTRY_SKIP_BROWSER === '1';
    if (!skipBrowser) {
      try {
        await openBrowser(code.verification_uri_complete);
        browserOpened = true;
      } catch {
        // Headless or no DE. User can copy/paste manually.
      }
    }
    if (!browserOpened) {
      const reason = skipBrowser
        ? 'browser auto-open disabled'
        : 'could not auto-open browser';
      process.stdout.write(
        kleur.dim(`  (${reason} — copy the URL above)\n`),
      );
    }

    process.stdout.write('\n');
    const spinner = ora('Waiting for approval...').start();

    const deadline = Date.now() + code.expires_in * 1000;
    let pollIntervalMs = code.interval * 1000;
    // Tolerate transient network blips inside the polling window — a backend
    // restart shouldn't blow up an in-flight `reentry login`. Reset the
    // counter on every successful poll; abort only on sustained failure.
    const MAX_NETWORK_FAILURES = 5;
    let networkFailures = 0;

    while (Date.now() < deadline) {
      await sleep(pollIntervalMs);

      let result;
      try {
        result = await pollOnce(code.device_code);
        networkFailures = 0;
      } catch (err) {
        if (err instanceof ApiNetworkError) {
          networkFailures += 1;
          if (networkFailures >= MAX_NETWORK_FAILURES) {
            spinner.fail(
              `Network unreachable after ${MAX_NETWORK_FAILURES} retries: ${err.message}`,
            );
            return ExitCodes.NETWORK;
          }
          // Soft retry — keep the spinner running.
          continue;
        }
        throw err;
      }

      if (result.kind === 'token') {
        spinner.succeed('Approved.');
        writeCredentials({
          apiUrl: apiUrl(),
          accessToken: result.accessToken,
          issuedAt: new Date().toISOString(),
        });
        process.stdout.write('\n');
        process.stdout.write(`  ${kleur.green('✓')} You're logged in.\n`);
        process.stdout.write(
          kleur.dim('  Run `reentry whoami` to see your team.\n'),
        );
        return ExitCodes.ALLOWED;
      }

      if (result.kind === 'expired') {
        spinner.fail(
          'Code expired before approval. Run `reentry login` to start over.',
        );
        return ExitCodes.AUTH;
      }

      if (result.kind === 'denied') {
        spinner.fail('Login denied.');
        return ExitCodes.AUTH;
      }

      if (result.kind === 'slow_down') {
        // Server told us to back off. Bump interval by 5s.
        pollIntervalMs += 5000;
      }
      // 'pending' falls through and we poll again.
    }

    spinner.fail('Timed out waiting for approval.');
    return ExitCodes.AUTH;
  } catch (err) {
    if (err instanceof ApiNetworkError) {
      process.stderr.write(`${kleur.red('error:')} ${err.message}\n`);
      return ExitCodes.NETWORK;
    }
    const message = err instanceof Error ? err.message : 'unknown error';
    process.stderr.write(`${kleur.red('error:')} ${message}\n`);
    return ExitCodes.INTERNAL;
  }
}
