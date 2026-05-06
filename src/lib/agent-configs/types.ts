/**
 * Common types shared by the per-agent config writers.
 *
 * Each agent (claude-code, cursor) has its own config file format. We keep
 * a single internal description of the server we want installed, and let
 * each writer translate that into the agent's expected JSON shape.
 */

export interface ReentryServerSpec {
	/** Backend API URL — the bearer token is scoped to this URL. */
	apiUrl: string;
	/** Bearer token from ~/.config/reentry/credentials.json. */
	accessToken: string;
}

/** Agent identifiers we currently support. */
export type AgentId = "claude-code" | "cursor";

export interface AgentConfigPaths {
	/** User-global config path (e.g., ~/.claude.json or ~/.cursor/mcp.json). */
	global: string;
	/** Project-local config path (e.g., .mcp.json or .cursor/mcp.json), relative to cwd. */
	local: string;
}

export interface AgentInstallStatus {
	agent: AgentId;
	configPath: string;
	installed: boolean;
	/** When installed, the URL we wrote (so users can audit drift). */
	url?: string;
}
