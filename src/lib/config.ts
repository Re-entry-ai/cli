import * as os from 'os';
import * as path from 'path';

const PROD_API_URL = 'https://api.re-entry.ai';

/**
 * Resolve the backend API URL.
 *
 * Precedence: REENTRY_API_URL env var → production default. We deliberately
 * keep this simple — no per-machine config file overrides for the API URL.
 * Power users who need a custom endpoint set the env var.
 */
export function apiUrl(): string {
  const fromEnv = process.env.REENTRY_API_URL;
  if (fromEnv && fromEnv.trim().length > 0) {
    return fromEnv.replace(/\/$/, '');
  }
  return PROD_API_URL;
}

/**
 * Path to the credentials file. Stored at mode 0600 (read/write owner only).
 * Honors XDG_CONFIG_HOME if set; otherwise ~/.config/reentry/credentials.json.
 */
export function credentialsPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.trim().length > 0 ? xdg : path.join(os.homedir(), '.config');
  return path.join(base, 'reentry', 'credentials.json');
}

/**
 * Get the User-Agent the CLI sends on every backend call. Lets the backend
 * (and the Observe surface's clientName field) attribute calls to the CLI.
 */
export function userAgent(): string {
  return `reentry-cli/${CLI_VERSION}`;
}

/**
 * Embedded version string. Updated when we cut a release.
 * Kept inline so the bundled binary doesn't have to read package.json at runtime.
 */
export const CLI_VERSION = '0.1.0';
