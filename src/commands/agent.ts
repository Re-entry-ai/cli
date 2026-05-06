import { Command } from "commander";
import kleur from "kleur";
import { ExitCodes, ExitCode } from "../lib/exit-codes";
import { readCredentials } from "../lib/storage";
import {
	addClaudeCode,
	removeClaudeCode,
	statusClaudeCode,
} from "../lib/agent-configs/claude-code";
import {
	addCursor,
	removeCursor,
	statusCursor,
} from "../lib/agent-configs/cursor";
import { AgentId } from "../lib/agent-configs/types";
import { InvalidApiUrlError } from "../lib/agent-configs/validate-api-url";

const SUPPORTED_AGENTS: readonly AgentId[] = ["claude-code", "cursor"] as const;

interface CommonOptions {
	json?: boolean;
	global?: boolean;
}

interface AddOptions extends CommonOptions {
	force?: boolean;
}

function emitJson(payload: unknown): void {
	process.stdout.write(JSON.stringify(payload) + "\n");
}

function isSupportedAgent(name: string): name is AgentId {
	return (SUPPORTED_AGENTS as readonly string[]).includes(name);
}

function unknownAgent(name: string, options: CommonOptions): ExitCode {
	const message = `unknown agent "${name}". Supported: ${SUPPORTED_AGENTS.join(", ")}.`;
	if (options.json) {
		emitJson({ success: false, code: "USAGE", message });
	} else {
		process.stderr.write(`${kleur.red("error:")} ${message}\n`);
	}
	return ExitCodes.USAGE;
}

async function agentAddCommand(
	agent: string,
	options: AddOptions,
): Promise<ExitCode> {
	if (!isSupportedAgent(agent)) {
		return unknownAgent(agent, options);
	}

	const creds = readCredentials();
	if (!creds) {
		const message =
			"Not logged in. Run `reentry login` first — `agent add` writes your bearer token into the IDE config.";
		if (options.json) {
			emitJson({ success: false, code: "AUTH", message });
		} else {
			process.stderr.write(`${kleur.red("error:")} ${message}\n`);
		}
		return ExitCodes.AUTH;
	}

	const spec = {
		apiUrl: creds.apiUrl,
		accessToken: creds.accessToken,
	};
	const opts = { global: options.global, force: options.force };
	let result;
	try {
		result =
			agent === "claude-code" ? addClaudeCode(spec, opts) : addCursor(spec, opts);
	} catch (err) {
		if (err instanceof InvalidApiUrlError) {
			if (options.json) {
				emitJson({
					success: false,
					code: "INVALID_API_URL",
					message: err.message,
				});
			} else {
				process.stderr.write(`${kleur.red("error:")} ${err.message}\n`);
			}
			return ExitCodes.USAGE;
		}
		throw err;
	}

	if (result.outcome === "stale") {
		const message = `existing reentry-ai entry in ${result.configPath} differs from the current login. Re-run with --force to overwrite, or remove with \`reentry agent remove ${agent}\`.`;
		if (options.json) {
			emitJson({
				success: false,
				code: "STALE_CONFIG",
				message,
				agent,
				configPath: result.configPath,
			});
		} else {
			process.stderr.write(`${kleur.red("error:")} ${message}\n`);
		}
		return ExitCodes.USAGE;
	}

	if (options.json) {
		emitJson({
			success: true,
			agent,
			configPath: result.configPath,
			outcome: result.outcome,
		});
		return ExitCodes.ALLOWED;
	}

	process.stdout.write("\n");
	if (result.outcome === "noop") {
		process.stdout.write(
			`  ${kleur.dim("✓")} ${agent} already configured at ${result.configPath}\n`,
		);
	} else if (result.outcome === "updated") {
		process.stdout.write(
			`  ${kleur.green("✓")} Updated ${agent} config at ${result.configPath}\n`,
		);
	} else {
		process.stdout.write(
			`  ${kleur.green("✓")} Configured ${agent} at ${result.configPath}\n`,
		);
	}
	if (agent === "claude-code") {
		process.stdout.write(
			kleur.dim(
				"  Restart Claude Code (or run /mcp) to pick up the new server.\n",
			),
		);
	} else {
		process.stdout.write(
			kleur.dim("  Restart Cursor to pick up the new server.\n"),
		);
	}
	process.stdout.write("\n");
	return ExitCodes.ALLOWED;
}

function agentRemoveCommand(agent: string, options: CommonOptions): ExitCode {
	if (!isSupportedAgent(agent)) {
		return unknownAgent(agent, options);
	}

	const opts = { global: options.global };
	const result =
		agent === "claude-code" ? removeClaudeCode(opts) : removeCursor(opts);

	if (options.json) {
		emitJson({
			success: true,
			agent,
			configPath: result.configPath,
			outcome: result.outcome,
		});
		return ExitCodes.ALLOWED;
	}

	process.stdout.write("\n");
	if (result.outcome === "absent") {
		process.stdout.write(
			`  ${kleur.dim("✓")} ${agent} not configured (nothing to remove).\n`,
		);
	} else {
		process.stdout.write(
			`  ${kleur.green("✓")} Removed reentry-ai from ${result.configPath}\n`,
		);
	}
	process.stdout.write("\n");
	return ExitCodes.ALLOWED;
}

function agentListCommand(options: CommonOptions): ExitCode {
	const claudeCodeStatus = statusClaudeCode({ global: options.global });
	const cursorStatus = statusCursor({ global: options.global });

	if (options.json) {
		emitJson({
			agents: [
				{
					agent: "claude-code",
					configPath: claudeCodeStatus.configPath,
					installed: claudeCodeStatus.installed,
					url: claudeCodeStatus.url,
				},
				{
					agent: "cursor",
					configPath: cursorStatus.configPath,
					installed: cursorStatus.installed,
					url: cursorStatus.url,
				},
			],
		});
		return ExitCodes.ALLOWED;
	}

	const renderRow = (
		label: string,
		installed: boolean,
		configPath: string,
		url?: string,
	): void => {
		const tick = installed
			? kleur.green("✓ installed")
			: kleur.dim("  not installed");
		process.stdout.write(
			`  ${label.padEnd(13)} ${tick}  ${kleur.dim(configPath)}\n`,
		);
		if (installed && url) {
			process.stdout.write(
				`  ${" ".repeat(13)}   ${kleur.dim(`url: ${url}`)}\n`,
			);
		}
	};

	process.stdout.write("\n");
	process.stdout.write(`  ${kleur.bold("Agent integrations")}\n`);
	process.stdout.write("\n");
	renderRow(
		"claude-code",
		claudeCodeStatus.installed,
		claudeCodeStatus.configPath,
		claudeCodeStatus.url,
	);
	renderRow(
		"cursor",
		cursorStatus.installed,
		cursorStatus.configPath,
		cursorStatus.url,
	);
	process.stdout.write("\n");
	return ExitCodes.ALLOWED;
}

/**
 * Build the `agent` command tree for the main commander program.
 *
 * Subcommands:
 *  - reentry agent add <claude-code|cursor> [--global] [--force] [--json]
 *  - reentry agent remove <claude-code|cursor> [--global] [--json]
 *  - reentry agent list [--global] [--json]
 */
export function buildAgentCommand(): Command {
	const cmd = new Command("agent").description(
		"Wire re-entry.ai into IDE/agent MCP configs (claude-code, cursor).",
	);

	cmd
		.command("add <agent>")
		.description(
			"Add the re-entry MCP server to the chosen agent. Auto-writes config; idempotent.",
		)
		.option("--global", "write to user-global config instead of project-local")
		.option("--force", "overwrite an existing reentry-ai entry that differs")
		.option("--json", "machine-readable output")
		.action(async (agent: string, options: AddOptions) => {
			const code = await agentAddCommand(agent, options);
			process.exit(code);
		});

	cmd
		.command("remove <agent>")
		.description("Remove the re-entry MCP server from the chosen agent config.")
		.option(
			"--global",
			"remove from user-global config instead of project-local",
		)
		.option("--json", "machine-readable output")
		.action((agent: string, options: CommonOptions) => {
			const code = agentRemoveCommand(agent, options);
			process.exit(code);
		});

	cmd
		.command("list")
		.description("Show install status for each supported agent.")
		.option("--global", "check user-global config locations")
		.option("--json", "machine-readable output")
		.action((options: CommonOptions) => {
			const code = agentListCommand(options);
			process.exit(code);
		});

	return cmd;
}
