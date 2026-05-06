import kleur from "kleur";
import { ExitCodes } from "../lib/exit-codes";
import { readCredentials } from "../lib/storage";
import { readRemoteOriginUrl } from "../lib/git";
import { callMcpTool } from "../lib/mcp-client";
import { handleMcpError } from "./pre-commit";

function emitUsage(message: string, options: { json?: boolean }): void {
	if (options.json) {
		process.stdout.write(
			JSON.stringify({ success: false, code: "USAGE", message }) + "\n",
		);
		return;
	}
	process.stderr.write(`${kleur.red("error:")} ${message}\n`);
}

interface ExplainOptions {
	json?: boolean;
	repository?: string;
}

interface ExplainResponse {
	humanReadable: string;
	structured: {
		riskScore?: number;
		riskLevel?: string;
		factors: Array<{ name: string; score: number; description: string }>;
		policiesEvaluated: number;
		policiesMatched: number;
		decision?: string;
		interventionStatus?: string;
	};
	explainedAt: string;
}

export async function explainCommand(
	prNumberArg: string | undefined,
	options: ExplainOptions,
): Promise<number> {
	const creds = readCredentials();
	if (!creds) {
		if (options.json) {
			process.stdout.write(
				JSON.stringify({
					success: false,
					code: "AUTH",
					message: "Not logged in. Run `reentry login`.",
				}) + "\n",
			);
		} else {
			process.stderr.write(
				`${kleur.red("error:")} Not logged in. Run \`reentry login\`.\n`,
			);
		}
		return ExitCodes.AUTH;
	}

	// Auto-detect from `git remote get-url origin` when --repository is absent.
	const repository = options.repository ?? readRemoteOriginUrl();
	if (!repository) {
		emitUsage(
			"--repository <owner/name> is required (or run inside a git repo with a github.com origin remote).",
			options,
		);
		return ExitCodes.USAGE;
	}

	if (!prNumberArg) {
		emitUsage("PR number is required.", options);
		return ExitCodes.USAGE;
	}
	const prNumber = Number(prNumberArg);
	if (!Number.isFinite(prNumber) || prNumber <= 0) {
		emitUsage("PR number must be a positive integer.", options);
		return ExitCodes.USAGE;
	}

	try {
		const result = await callMcpTool<ExplainResponse>(
			"explain_decision",
			{ repository, prNumber },
			creds.accessToken,
		);

		if (options.json) {
			process.stdout.write(JSON.stringify(result) + "\n");
			return ExitCodes.ALLOWED;
		}

		process.stdout.write("\n");
		process.stdout.write(`  ${result.humanReadable}\n`);
		process.stdout.write("\n");

		const factors = result.structured.factors;
		if (factors.length > 0) {
			process.stdout.write("  Top risk factors:\n");
			for (const f of factors.slice(0, 5)) {
				process.stdout.write(
					`    • ${kleur.bold(f.name)} ${kleur.dim(`(${f.score})`)}: ${f.description}\n`,
				);
			}
			process.stdout.write("\n");
		}

		return ExitCodes.ALLOWED;
	} catch (err) {
		return handleMcpError(err, "explain", { json: options.json });
	}
}
