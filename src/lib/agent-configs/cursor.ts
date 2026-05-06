import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  deepEqual,
  readJsonObject,
  writeJsonObjectAtomic,
} from './json-merge';
import { ReentryServerSpec } from './types';

export const REENTRY_SERVER_KEY = 'reentry-ai';

/**
 * Resolve the Cursor MCP config path.
 *
 * Cursor reads MCP config from ~/.cursor/mcp.json (global) or
 * <cwd>/.cursor/mcp.json (project). Project-local is preferred — checked
 * into the repo so teammates pick it up automatically.
 */
export function cursorConfigPath(global: boolean): string {
  if (global) {
    return path.join(os.homedir(), '.cursor', 'mcp.json');
  }
  return path.join(process.cwd(), '.cursor', 'mcp.json');
}

/**
 * Cursor's MCP server schema is the bare URL + headers form (no `type`
 * discriminator). Cursor infers transport from the shape: presence of
 * `command` means stdio; presence of `url` means HTTP.
 */
function buildEntry(spec: ReentryServerSpec): Record<string, unknown> {
  return {
    url: `${spec.apiUrl.replace(/\/$/, '')}/mcp`,
    headers: {
      Authorization: `Bearer ${spec.accessToken}`,
    },
  };
}

export interface CursorAddResult {
  configPath: string;
  outcome: 'installed' | 'updated' | 'noop' | 'stale';
}

export function addCursor(
  spec: ReentryServerSpec,
  options: { global?: boolean; force?: boolean } = {},
): CursorAddResult {
  const configPath = cursorConfigPath(options.global ?? false);
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

  try {
    fs.chmodSync(configPath, 0o600);
  } catch {
    // Best-effort.
  }

  return {
    configPath,
    outcome: existing !== undefined ? 'updated' : 'installed',
  };
}

export interface CursorRemoveResult {
  configPath: string;
  outcome: 'removed' | 'absent';
}

export function removeCursor(
  options: { global?: boolean } = {},
): CursorRemoveResult {
  const configPath = cursorConfigPath(options.global ?? false);

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
      // Fall through.
    }
  }

  writeJsonObjectAtomic(configPath, next);
  return { configPath, outcome: 'removed' };
}

export interface CursorStatusResult {
  configPath: string;
  installed: boolean;
  url?: string;
}

export function statusCursor(
  options: { global?: boolean } = {},
): CursorStatusResult {
  const configPath = cursorConfigPath(options.global ?? false);
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
