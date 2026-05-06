import kleur from "kleur";
import { ExitCodes } from "../lib/exit-codes";
import { readCredentials } from "../lib/storage";
import { callMcpTool } from "../lib/mcp-client";
import { handleMcpError } from "./pre-commit";
import { safeText } from "../lib/safe-print";

interface RulesOptions {
	json?: boolean;
}

interface PolicyRule {
	name: string;
	description: string;
	conditions: string;
	consequence: string;
}

interface TeamRulesResponse {
	policies: PolicyRule[];
	riskCriteria: {
		highRiskPatterns: string[];
		requiredPractices: string[];
		autoBlockThreshold: number | null;
	};
	dismissedGuidance: string[];
}

export async function rulesCommand(options: RulesOptions): Promise<number> {
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

	try {
		const result = await callMcpTool<TeamRulesResponse>(
			"get_team_rules",
			{},
			creds.accessToken,
		);

		if (options.json) {
			// JSON mode: emit the raw response. The caller is responsible for
			// tolerating shape variance.
			process.stdout.write(JSON.stringify(result) + "\n");
			return ExitCodes.ALLOWED;
		}

		// Render mode: defensively normalize the shape so a partial / future
		// backend response doesn't crash the CLI on .map / .length.
		renderRules(normalize(result));
		return ExitCodes.ALLOWED;
	} catch (err) {
		return handleMcpError(err, "fetch team rules", { json: options.json });
	}
}

/**
 * Type guard for "this entry is a non-empty string" — used in defensive
 * `.filter()` calls when normalizing untrusted MCP responses. Named
 * descriptively rather than the conventional `s` per the team's clean-code
 * rule (no single-letter variables, even in narrow callbacks).
 */
function isNonEmptyString(candidate: unknown): candidate is string {
	return typeof candidate === "string";
}

function normalize(rawResponse: unknown): TeamRulesResponse {
	const responseObject = (
		rawResponse && typeof rawResponse === "object" ? rawResponse : {}
	) as Record<string, unknown>;

	const policiesArray = Array.isArray(responseObject.policies)
		? (responseObject.policies as unknown[])
		: [];
	const policies: PolicyRule[] = policiesArray
		.filter(
			(policyEntry): policyEntry is Record<string, unknown> =>
				!!policyEntry && typeof policyEntry === "object",
		)
		.map((policyEntry) => ({
			name:
				typeof policyEntry.name === "string"
					? safeText(policyEntry.name)
					: "(unnamed)",
			description:
				typeof policyEntry.description === "string"
					? safeText(policyEntry.description)
					: "",
			conditions:
				typeof policyEntry.conditions === "string"
					? safeText(policyEntry.conditions)
					: "(no conditions)",
			consequence:
				typeof policyEntry.consequence === "string"
					? safeText(policyEntry.consequence)
					: "(no consequence)",
		}));

	const riskCriteriaObject = (
		responseObject.riskCriteria && typeof responseObject.riskCriteria === "object"
			? (responseObject.riskCriteria as Record<string, unknown>)
			: {}
	) as Record<string, unknown>;
	const highRiskPatterns = Array.isArray(riskCriteriaObject.highRiskPatterns)
		? (riskCriteriaObject.highRiskPatterns as unknown[])
				.filter(isNonEmptyString)
				.map(safeText)
		: [];
	const requiredPractices = Array.isArray(riskCriteriaObject.requiredPractices)
		? (riskCriteriaObject.requiredPractices as unknown[])
				.filter(isNonEmptyString)
				.map(safeText)
		: [];
	const autoBlockThreshold =
		typeof riskCriteriaObject.autoBlockThreshold === "number"
			? riskCriteriaObject.autoBlockThreshold
			: null;
	const dismissedGuidance = Array.isArray(responseObject.dismissedGuidance)
		? (responseObject.dismissedGuidance as unknown[])
				.filter(isNonEmptyString)
				.map(safeText)
		: [];

	return {
		policies,
		riskCriteria: {
			highRiskPatterns,
			requiredPractices,
			autoBlockThreshold,
		},
		dismissedGuidance,
	};
}

function renderRules(rules: TeamRulesResponse): void {
	process.stdout.write("\n");
	process.stdout.write(`  ${kleur.bold("Active policies")}\n`);
	if (rules.policies.length === 0) {
		process.stdout.write(`    ${kleur.dim("(none — defaults apply)")}\n`);
	} else {
		for (const policy of rules.policies) {
			process.stdout.write(
				`    ${kleur.green("✓")} ${kleur.bold(policy.name)}\n`,
			);
			process.stdout.write(`      ${kleur.dim(policy.description)}\n`);
			process.stdout.write(
				`      ${kleur.dim(`When: ${policy.conditions}`)}\n`,
			);
			process.stdout.write(
				`      ${kleur.dim(`Then: ${policy.consequence}`)}\n`,
			);
			process.stdout.write("\n");
		}
	}

	process.stdout.write(`  ${kleur.bold("High-risk patterns to avoid")}\n`);
	if (rules.riskCriteria.highRiskPatterns.length === 0) {
		process.stdout.write(`    ${kleur.dim("(none documented)")}\n`);
	} else {
		for (const pattern of rules.riskCriteria.highRiskPatterns) {
			process.stdout.write(`    ${kleur.yellow("•")} ${pattern}\n`);
		}
	}
	process.stdout.write("\n");

	process.stdout.write(`  ${kleur.bold("Required practices")}\n`);
	if (rules.riskCriteria.requiredPractices.length === 0) {
		process.stdout.write(`    ${kleur.dim("(none required)")}\n`);
	} else {
		for (const practice of rules.riskCriteria.requiredPractices) {
			process.stdout.write(`    ${kleur.green("✓")} ${practice}\n`);
		}
	}
	process.stdout.write("\n");

	if (rules.riskCriteria.autoBlockThreshold !== null) {
		process.stdout.write(
			`  ${kleur.bold("Auto-block threshold:")} ${kleur.red(
				`risk score ≥ ${rules.riskCriteria.autoBlockThreshold}`,
			)}\n\n`,
		);
	}

	if (rules.dismissedGuidance.length > 0) {
		process.stdout.write(
			`  ${kleur.dim(
				`(${rules.dismissedGuidance.length} guidance items dismissed by team)`,
			)}\n\n`,
		);
	}
}
