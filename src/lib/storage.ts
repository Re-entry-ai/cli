import * as fs from 'fs';
import * as path from 'path';
import { credentialsPath } from './config';

interface Credentials {
  /** API URL the token was issued against — guard against accidental cross-env use. */
  apiUrl: string;
  /** Plaintext mcp_re_* token. Stored at mode 0600. */
  accessToken: string;
  /** ISO timestamp the token was first stored. Diagnostics only. */
  issuedAt: string;
}

/**
 * Read stored credentials, or null if none exist.
 *
 * Returns null on:
 *  - File doesn't exist
 *  - File can't be read or parsed (treated like absent — we don't want to
 *    leak a corrupted credential and we don't want to fail loudly when the
 *    user just hasn't logged in yet)
 */
export function readCredentials(): Credentials | null {
  const file = credentialsPath();

  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }

  // Validate file mode is 0600. We wrote it that way; if it's been loosened
  // (manual chmod, restore from backup, dotfile sync) auto-tighten and warn
  // once. Stay friendly here — refusing to load would break users who didn't
  // know the mode drifted. Testing showed this is silent today.
  try {
    const stat = fs.statSync(file);
    const mode = stat.mode & 0o777;
    if (mode !== 0o600) {
      process.stderr.write(
        `warning: credentials file ${file} was mode ${mode.toString(8).padStart(4, '0')}; tightening to 0600.\n`,
      );
      try {
        fs.chmodSync(file, 0o600);
      } catch {
        // chmod can fail on platforms without POSIX perms (Windows/WSL edge);
        // we still return the credentials — the warning is the contract.
      }
    }
  } catch {
    // statSync can race with delete; treat as harmless.
  }

  try {
    const parsed = JSON.parse(raw) as Partial<Credentials>;
    if (
      typeof parsed.apiUrl === 'string' &&
      typeof parsed.accessToken === 'string' &&
      typeof parsed.issuedAt === 'string'
    ) {
      return parsed as Credentials;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Write credentials atomically with mode 0600.
 *
 * We write to a sibling temp file then rename. The temp file is created with
 * O_EXCL so a hostile pre-existing symlink can't redirect our write.
 */
export function writeCredentials(creds: Credentials): void {
  const file = credentialsPath();
  const dir = path.dirname(file);

  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const tmp = `${file}.${process.pid}.tmp`;

  // wx — fail if the temp already exists; defends against stale tmp + symlink races.
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(creds, null, 2), { encoding: 'utf8' });
  } finally {
    fs.closeSync(fd);
  }

  // Atomic replace.
  fs.renameSync(tmp, file);
}

/**
 * Best-effort delete. No-op if the file doesn't exist; throws on other errors
 * so the user knows logout didn't actually clear anything.
 */
export function deleteCredentials(): boolean {
  const file = credentialsPath();
  try {
    fs.unlinkSync(file);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw err;
  }
}
