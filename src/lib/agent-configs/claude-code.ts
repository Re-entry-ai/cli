import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  deepEqual,
  readJsonObject,
  writeJsonObjectAtomic,
} from './json-merge';
import { ReentryServerSpec } from './types';
import { toMcpUrl } from './validate-api-url';

/** Key under which our server is registered. Stable for upgrades + removal. */
export const REENTRY_SERVER_KEY = 'reentry-ai';

/**
 * Resolve the Claude Code config path.
 *
 * Two locations are supported:
 *  - Global: ~/.claude.json (Claude Code's user-level MCP server registry)
 *  - Project: <cwd>/.mcp.json (committed to the repo so the team shares it)
 *
 * We pick project-local by default — that way teammates pick it up via
 * `git pull` without each person re-running `agent add`.
 */
export function claudeCodeConfigPath(global: boolean): string {
  if (global) {
    return path.join(os.homedir(), '.claude.json');
  }
  return path.join(process.cwd(), '.mcp.json');
}

/**
 * Build the Claude Code server entry. Claude Code's MCP schema includes a
 * `type` discriminator (http | stdio | sse). Reentry's server is
 * Streamable-HTTP; we send the bearer token in an Authorization header.
 *
 * Throws `InvalidApiUrlError` if `spec.apiUrl` is not an https:// URL
 * (or http://localhost for development) — see validate-api-url.ts.
 */
function buildEntry(spec: ReentryServerSpec): Record<string, unknown> {
  return {
    type: 'http',
    url: toMcpUrl(spec.apiUrl),
    headers: {
      Authorization: `Bearer ${spec.accessToken}`,
    },
  };
}

export interface ClaudeCodeAddResult {
  /** Absolute path of the file we wrote. */
  configPath: string;
  /** "installed" = first-time, "updated" = had stale entry, "noop" = already current. */
  outcome: 'installed' | 'updated' | 'noop' | 'stale';
}

/**
 * Install the Reentry MCP server entry into Claude Code's config.
 *
 * Behavior:
 *  - Preserves every other key in the file (other servers, other settings).
 *  - Idempotent: re-running with the same spec is a no-op.
 *  - Stale-detection: if a `reentry-ai` entry exists with different shape,
 *    refuses to overwrite unless `force: true`.
 */
export function addClaudeCode(
  spec: ReentryServerSpec,
  options: { global?: boolean; force?: boolean } = {},
): ClaudeCodeAddResult {
  const configPath = claudeCodeConfigPath(options.global ?? false);
  const root = readJsonObject(configPath);

  const servers = (root.mcpServers as Record<string, unknown> | undefined) ?? {};
  const existing = servers[REENTRY_SERVER_KEY];
  const desired = buildEntry(spec);

  if (existing !== undefined) {
    if (deepEqual(existing, desired)) {
      return { configPath, outcome: 'noop' };
    }
    if (!options.force) {
      return { configPath, outcome: 'stale' };
    }
  }

  const nextServers = { ...servers, [REENTRY_SERVER_KEY]: desired };
  const next = { ...root, mcpServers: nextServers };
  writeJsonObjectAtomic(configPath, next);

  // Tighten the file to 0600 — it now contains a bearer token. Claude Code
  // tolerates restrictive perms; this is the same posture as
  // ~/.config/reentry/credentials.json.
  //
  // If chmod fails, surface a stderr warning rather than swallowing —
  // a security-relevant operation failing silently is a smell, and the
  // user has no other signal that the bearer-token file is now readable
  // by other users on the system.
  try {
    fs.chmodSync(configPath, 0o600);
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'unknown error';
    // Log the basename only — full paths can leak home dir / project layout
    // to centralized log collectors. The user knows where their own MCP
    // config lives; if they don't, the printed file write line above has
    // already shown the path.
    process.stderr.write(
      `warning: could not chmod 0600 ${path.basename(configPath)} (${detail}). The bearer token may be readable by other local users.\n`,
    );
  }

  return {
    configPath,
    outcome: existing !== undefined ? 'updated' : 'installed',
  };
}

export interface ClaudeCodeRemoveResult {
  configPath: string;
  outcome: 'removed' | 'absent';
}

/**
 * Remove only the Reentry server entry. Preserves every other key. If
 * removing leaves `mcpServers` empty, drops that parent key too. If the
 * resulting file is `{}`, deletes the file.
 */
export function removeClaudeCode(
  options: { global?: boolean } = {},
): ClaudeCodeRemoveResult {
  const configPath = claudeCodeConfigPath(options.global ?? false);

  let root: Record<string, unknown>;
  try {
    root = readJsonObject(configPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { configPath, outcome: 'absent' };
    }
    throw err;
  }

  const servers = (root.mcpServers as Record<string, unknown> | undefined) ?? {};
  if (servers[REENTRY_SERVER_KEY] === undefined) {
    return { configPath, outcome: 'absent' };
  }

  // Use destructuring to drop the key without mutating `servers` in place.
  const { [REENTRY_SERVER_KEY]: _removed, ...remainingServers } = servers;
  void _removed;

  const next: Record<string, unknown> = { ...root };
  if (Object.keys(remainingServers).length === 0) {
    delete next.mcpServers;
  } else {
    next.mcpServers = remainingServers;
  }

  if (Object.keys(next).length === 0) {
    try {
      fs.unlinkSync(configPath);
      return { configPath, outcome: 'removed' };
    } catch {
      // Fall through to writing an empty object — better than leaving a
      // half-deleted state.
    }
  }

  writeJsonObjectAtomic(configPath, next);
  return { configPath, outcome: 'removed' };
}

export interface ClaudeCodeStatusResult {
  configPath: string;
  installed: boolean;
  url?: string;
}

/** Inspect current install state without modifying anything. */
export function statusClaudeCode(
  options: { global?: boolean } = {},
): ClaudeCodeStatusResult {
  const configPath = claudeCodeConfigPath(options.global ?? false);
  let root: Record<string, unknown>;
  try {
    root = readJsonObject(configPath);
  } catch {
    return { configPath, installed: false };
  }
  const servers = (root.mcpServers as Record<string, unknown> | undefined) ?? {};
  const entry = servers[REENTRY_SERVER_KEY] as
    | Record<string, unknown>
    | undefined;
  if (!entry) {
    return { configPath, installed: false };
  }
  return {
    configPath,
    installed: true,
    url: typeof entry.url === 'string' ? entry.url : undefined,
  };
}
