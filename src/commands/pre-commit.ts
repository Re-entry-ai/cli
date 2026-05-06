import kleur from "kleur";
import { ExitCodes, ExitCode } from "../lib/exit-codes";
import { readCredentials } from "../lib/storage";
import { readStagedDiff, readCurrentBranch } from "../lib/git";
import { callMcpTool, McpAuthRejected, McpToolError } from "../lib/mcp-client";
import { ApiNetworkError } from "../lib/api";

interface PreCommitOptions {
	json?: boolean;
}

interface PreCommitResponse {
	riskScore: number;
	riskLevel: string;
	safe: boolean;
	summary: string;
	reviewFocus: string;
	keyFindings: string[];
	inlineComments: Array<{
		path: string;
		line: number;
		body: string;
		severity: string;
	}>;
	agentInstructions: string;
	dashboardUrl: string;
}

/**
 * Map riskLevel → exit code. The contract:
 *   safe / low / medium  → 0 (ALLOWED, allow the commit through)
 *   high                  → 2 (REQUIRES_HUMAN — pause, ask for review)
 *   critical              → 1 (BLOCKED — refuse the commit)
 *
 * `medium` lands in ALLOWED for v1; teams can tune their policy to surface
 * mediums later via the dashboard if they want to be stricter.
 */
function exitCodeForRisk(level: string): ExitCode {
	const normalized = level.toLowerCase();
	if (normalized === "critical") {
		return ExitCodes.BLOCKED;
	}
	if (normalized === "high") {
		return ExitCodes.REQUIRES_HUMAN;
	}
	return ExitCodes.ALLOWED;
}

export async function preCommitCommand(
	options: PreCommitOptions,
): Promise<number> {
	const creds = readCredentials();
	if (!creds) {
		process.stderr.write(
			`${kleur.red("error:")} Not logged in. Run \`reentry login\`.\n`,
		);
		return ExitCodes.AUTH;
	}

	const diff = readStagedDiff();
	if (diff === null) {
		process.stderr.write(
			`${kleur.red("error:")} Not a git repository, or git not installed.\n`,
		);
		return ExitCodes.USAGE;
	}

	if (diff.trim().length === 0) {
		if (options.json) {
			process.stdout.write(
				JSON.stringify({ skipped: true, reason: "no_staged_changes" }) + "\n",
			);
		} else {
			process.stdout.write(
				kleur.dim("No staged changes — nothing to check.\n"),
			);
		}
		return ExitCodes.ALLOWED;
	}

	const branch = readCurrentBranch();

	try {
		const result = await callMcpTool<PreCommitResponse>(
			"pre_commit_check",
			{
				diff,
				branch: branch ?? undefined,
			},
			creds.accessToken,
		);

		const exit = exitCodeForRisk(result.riskLevel);

		if (options.json) {
			process.stdout.write(JSON.stringify(result) + "\n");
			return exit;
		}

		renderPreCommit(result, exit);
		return exit;
	} catch (err) {
		return handleMcpError(err, "pre-commit check", { json: options.json });
	}
}

function renderPreCommit(result: PreCommitResponse, exit: ExitCode): void {
	const colorFor = (level: string): ((s: string) => string) => {
		const k = level.toLowerCase();
		if (k === "critical") {
			return kleur.red().bold;
		}
		if (k === "high") {
			return kleur.yellow().bold;
		}
		if (k === "medium") {
			return kleur.yellow;
		}
		return kleur.green;
	};

	const colorize = colorFor(result.riskLevel);

	process.stdout.write("\n");
	process.stdout.write(
		`  Risk: ${colorize(result.riskLevel.toUpperCase())} ${kleur.dim(`(score ${result.riskScore}/100)`)}\n`,
	);
	process.stdout.write(`  ${result.summary}\n`);
	process.stdout.write("\n");

	if (result.keyFindings.length > 0) {
		process.stdout.write("  Key findings:\n");
		for (const finding of result.keyFindings) {
			process.stdout.write(`    • ${finding}\n`);
		}
		process.stdout.write("\n");
	}

	if (exit === ExitCodes.BLOCKED) {
		process.stdout.write(
			`  ${kleur.red("✗")} Commit blocked. ${kleur.dim(`See ${result.dashboardUrl}`)}\n`,
		);
	} else if (exit === ExitCodes.REQUIRES_HUMAN) {
		process.stdout.write(
			`  ${kleur.yellow("⚠")} Review recommended before committing. ${kleur.dim(`See ${result.dashboardUrl}`)}\n`,
		);
	} else {
		process.stdout.write(`  ${kleur.green("✓")} OK to commit.\n`);
	}
	process.stdout.write("\n");
}

/** Backend error codes that mean "your token is valid but you cannot
 *  perform this action" — tier insufficient, scope/repo not allowed,
 *  enterprise-only feature, etc. The CLI maps these to ExitCodes.PERMISSION
 *  (77) so CI scripts can distinguish "your config is wrong" from "the CLI
 *  blew up." */
const PERMISSION_DENIED_CODES = new Set([
	"SCOPE_VIOLATION",
	"TIER_INSUFFICIENT",
	"FORBIDDEN",
	"GUARDIAN_ENTERPRISE_ONLY",
]);

/**
 * Backend McpToolError codes / messages that mean "the user asked about
 * something that doesn't exist" — wrong PR number, missing assessment.
 * These are usage errors (bad input), not internal failures.
 */
const NOT_FOUND_CODES = new Set(["NOT_FOUND", "VALIDATION_ERROR"]);
function isNotFoundError(err: McpToolError): boolean {
	if (err.code && NOT_FOUND_CODES.has(err.code)) {
		// VALIDATION_ERROR is broad — only treat as USAGE when the message
		// shape clearly indicates a missing record, not an input-shape error.
		if (err.code === "VALIDATION_ERROR") {
			return /no .* found|not found|does not exist/i.test(err.message);
		}
		return true;
	}
	return false;
}

interface ErrorOptions {
	/** Emit a JSON envelope to stdout instead of plain text to stderr. */
	json?: boolean;
}

function emitError(
	payload: { code: string; message: string; dashboardUrl?: string },
	fallback: string,
	opts: ErrorOptions,
): void {
	if (opts.json) {
		process.stdout.write(JSON.stringify({ success: false, ...payload }) + "\n");
		return;
	}
	process.stderr.write(`${kleur.red("error:")} ${fallback}\n`);
}

function handleMcpError(
	err: unknown,
	action: string,
	opts: ErrorOptions = {},
): number {
	if (err instanceof McpAuthRejected) {
		emitError(
			{
				code: "AUTH_REJECTED",
				message: "Token rejected. Run `reentry login` again.",
			},
			"Token rejected. Run `reentry login` again.",
			opts,
		);
		return ExitCodes.AUTH;
	}
	if (err instanceof ApiNetworkError) {
		emitError(
			{ code: "NETWORK_ERROR", message: err.message },
			err.message,
			opts,
		);
		return ExitCodes.NETWORK;
	}
	if (err instanceof McpToolError) {
		emitError(
			{ code: err.code ?? "TOOL_ERROR", message: err.message },
			`${action} failed: ${err.message}`,
			opts,
		);
		if (err.code && PERMISSION_DENIED_CODES.has(err.code)) {
			return ExitCodes.PERMISSION;
		}
		if (isNotFoundError(err)) {
			// The user pointed at something that doesn't exist — that's a usage
			// error, not an internal CLI bug. Mapping to USAGE makes CI scripts
			// distinguish "fix your input" from "the tool blew up."
			return ExitCodes.USAGE;
		}
		return ExitCodes.INTERNAL;
	}
	const message = err instanceof Error ? err.message : "unknown error";
	emitError({ code: "INTERNAL", message }, message, opts);
	return ExitCodes.INTERNAL;
}

export { handleMcpError };
