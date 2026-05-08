import { createHash } from "crypto";
import { readFile } from "fs/promises";
import { extname } from "path";
import kleur from "kleur";
import { ExitCodes } from "../lib/exit-codes";

interface VerifyOptions {
	json?: boolean;
}

interface EvidenceRow {
	rowHash: string;
	sourceTable: string;
	sourceId: string | null;
	capturedAt: string;
}

interface VerifyResult {
	ok: boolean;
	declaredHash: string;
	recomputedHash: string;
	rowCount: number;
	format: "json" | "csv";
	frameworkSlug: string | null;
	frameworkVersion: number | null;
	source: string;
}

function emit(
	output: Record<string, unknown>,
	options: VerifyOptions,
): void {
	if (options.json) {
		process.stdout.write(JSON.stringify(output) + "\n");
		return;
	}
}

/**
 * Recompute the export integrity hash. Mirrors the formula in
 * `backend/src/compliance/compliance-export.service.ts:computeIntegrityHash`.
 * Any change to that backend formula must change this one in lockstep.
 */
function computeIntegrityHash(rows: EvidenceRow[]): string {
	const hasher = createHash("sha256");
	for (const row of rows) {
		hasher.update(row.rowHash);
		hasher.update("|");
		hasher.update(row.sourceTable);
		hasher.update("|");
		hasher.update(row.sourceId ?? "TOMBSTONED");
		hasher.update("|");
		hasher.update(row.capturedAt);
		hasher.update("\n");
	}
	return hasher.digest("hex");
}

function detectFormat(path: string): "json" | "csv" | null {
	const ext: string = extname(path).toLowerCase();
	if (ext === ".json") {
		return "json";
	}
	if (ext === ".csv") {
		return "csv";
	}
	return null;
}

interface ParsedExport {
	rows: EvidenceRow[];
	declaredHash: string;
	frameworkSlug: string | null;
	frameworkVersion: number | null;
}

function parseJsonExport(contents: string): ParsedExport {
	const parsed: unknown = JSON.parse(contents);
	if (parsed === null || typeof parsed !== "object") {
		throw new Error("JSON export root is not an object");
	}
	const root: Record<string, unknown> = parsed as Record<string, unknown>;
	const integrityHash: unknown = root.integrityHash;
	if (typeof integrityHash !== "string") {
		throw new Error("JSON export missing string `integrityHash`");
	}
	const evidence: unknown = root.evidence;
	if (!Array.isArray(evidence)) {
		throw new Error("JSON export missing `evidence` array");
	}
	const rows: EvidenceRow[] = evidence.map(
		(entry: unknown, index: number): EvidenceRow => {
			if (entry === null || typeof entry !== "object") {
				throw new Error(`evidence[${index}] is not an object`);
			}
			const e: Record<string, unknown> = entry as Record<string, unknown>;
			const rowHash: unknown = e.rowHash;
			const sourceTable: unknown = e.sourceTable;
			const sourceId: unknown = e.sourceId;
			const capturedAt: unknown = e.capturedAt;
			if (typeof rowHash !== "string") {
				throw new Error(`evidence[${index}].rowHash is not a string`);
			}
			if (typeof sourceTable !== "string") {
				throw new Error(`evidence[${index}].sourceTable is not a string`);
			}
			if (typeof capturedAt !== "string") {
				throw new Error(`evidence[${index}].capturedAt is not a string`);
			}
			let normalisedSourceId: string | null;
			if (typeof sourceId === "string") {
				normalisedSourceId = sourceId;
			} else if (sourceId === null) {
				normalisedSourceId = null;
			} else {
				throw new Error(
					`evidence[${index}].sourceId is not string|null`,
				);
			}
			return {
				rowHash,
				sourceTable,
				sourceId: normalisedSourceId,
				capturedAt,
			};
		},
	);

	const framework: unknown = root.framework;
	let slug: string | null = null;
	let version: number | null = null;
	if (framework !== null && typeof framework === "object") {
		const f: Record<string, unknown> = framework as Record<string, unknown>;
		if (typeof f.slug === "string") {
			slug = f.slug;
		}
		if (typeof f.version === "number") {
			version = f.version;
		}
	}

	return {
		rows,
		declaredHash: integrityHash,
		frameworkSlug: slug,
		frameworkVersion: version,
	};
}

function parseCsvExport(contents: string): ParsedExport {
	const lines: string[] = contents.split(/\r?\n/);
	let declaredHash: string | null = null;
	let frameworkSlug: string | null = null;
	let frameworkVersion: number | null = null;
	let headerSeen: boolean = false;
	const rows: EvidenceRow[] = [];

	for (const line of lines) {
		if (line.length === 0) {
			continue;
		}
		if (line.startsWith("#")) {
			const meta: string = line.slice(1).trim();
			const hashMatch: RegExpMatchArray | null = meta.match(
				/integrity_hash=([0-9a-f]{64})/,
			);
			if (hashMatch !== null) {
				declaredHash = hashMatch[1];
			}
			const slugMatch: RegExpMatchArray | null = meta.match(
				/framework=([^\s]+)/,
			);
			if (slugMatch !== null) {
				frameworkSlug = slugMatch[1];
			}
			const versionMatch: RegExpMatchArray | null = meta.match(
				/version=(\d+)/,
			);
			if (versionMatch !== null) {
				frameworkVersion = parseInt(versionMatch[1], 10);
			}
			continue;
		}
		if (!headerSeen) {
			headerSeen = true;
			continue;
		}
		const cols: string[] = parseCsvLine(line);
		if (cols.length < 7) {
			throw new Error(`CSV row has ${cols.length} columns; expected 7`);
		}
		const sourceIdRaw: string = cols[3];
		rows.push({
			rowHash: cols[5],
			sourceTable: cols[2],
			sourceId: sourceIdRaw.length === 0 ? null : sourceIdRaw,
			capturedAt: cols[4],
		});
	}

	if (declaredHash === null) {
		throw new Error("CSV export missing `# integrity_hash=...` header");
	}

	return {
		rows,
		declaredHash,
		frameworkSlug,
		frameworkVersion,
	};
}

/**
 * Minimal CSV line parser handling quoted fields with escaped quotes.
 * The export writer escapes via doubled quotes per RFC 4180.
 */
function parseCsvLine(line: string): string[] {
	const result: string[] = [];
	let current: string = "";
	let inQuotes: boolean = false;
	let index: number = 0;
	while (index < line.length) {
		const ch: string = line[index];
		if (inQuotes) {
			if (ch === '"' && line[index + 1] === '"') {
				current += '"';
				index += 2;
				continue;
			}
			if (ch === '"') {
				inQuotes = false;
				index += 1;
				continue;
			}
			current += ch;
			index += 1;
			continue;
		}
		if (ch === '"') {
			inQuotes = true;
			index += 1;
			continue;
		}
		if (ch === ",") {
			result.push(current);
			current = "";
			index += 1;
			continue;
		}
		current += ch;
		index += 1;
	}
	result.push(current);
	return result;
}

export async function verifyCommand(
	pathArg: string | undefined,
	options: VerifyOptions,
): Promise<number> {
	if (pathArg === undefined || pathArg.length === 0) {
		emit(
			{
				success: false,
				code: "USAGE",
				message:
					"Usage: reentry verify <path-to-export.json|.csv> [--json]",
			},
			options,
		);
		if (!options.json) {
			process.stderr.write(
				`${kleur.red("error:")} missing path to export file\n`,
			);
		}
		return ExitCodes.USAGE;
	}

	const format: "json" | "csv" | null = detectFormat(pathArg);
	if (format === null) {
		emit(
			{
				success: false,
				code: "USAGE",
				message:
					"Unsupported export format. `reentry verify` accepts .json or .csv exports. PDF exports embed the integrity hash for visual cross-check; verify against the JSON or CSV companion.",
			},
			options,
		);
		if (!options.json) {
			process.stderr.write(
				`${kleur.red("error:")} unsupported format. Pass a .json or .csv export.\n`,
			);
		}
		return ExitCodes.USAGE;
	}

	let contents: string;
	try {
		contents = await readFile(pathArg, "utf8");
	} catch (err: unknown) {
		const message: string =
			err instanceof Error ? err.message : "Unknown error reading file";
		emit(
			{
				success: false,
				code: "FILE_READ",
				message,
			},
			options,
		);
		if (!options.json) {
			process.stderr.write(`${kleur.red("error:")} ${message}\n`);
		}
		return ExitCodes.USAGE;
	}

	let parsed: ParsedExport;
	try {
		if (format === "json") {
			parsed = parseJsonExport(contents);
		} else {
			parsed = parseCsvExport(contents);
		}
	} catch (err: unknown) {
		const message: string =
			err instanceof Error ? err.message : "Unknown parse error";
		emit(
			{
				success: false,
				code: "PARSE",
				message,
			},
			options,
		);
		if (!options.json) {
			process.stderr.write(`${kleur.red("error:")} ${message}\n`);
		}
		return ExitCodes.USAGE;
	}

	const recomputedHash: string = computeIntegrityHash(parsed.rows);
	const ok: boolean = recomputedHash === parsed.declaredHash;
	const result: VerifyResult = {
		ok,
		declaredHash: parsed.declaredHash,
		recomputedHash,
		rowCount: parsed.rows.length,
		format,
		frameworkSlug: parsed.frameworkSlug,
		frameworkVersion: parsed.frameworkVersion,
		source: pathArg,
	};

	if (options.json) {
		process.stdout.write(JSON.stringify(result) + "\n");
	} else {
		const frameworkLabel: string =
			parsed.frameworkSlug !== null
				? `${parsed.frameworkSlug}${parsed.frameworkVersion !== null ? ` v${parsed.frameworkVersion}` : ""}`
				: "(unknown framework)";
		if (ok) {
			process.stdout.write(
				`${kleur.green("✓")} integrity verified: ${frameworkLabel}, ${parsed.rows.length} evidence rows\n`,
			);
			process.stdout.write(
				`  hash: ${kleur.gray(parsed.declaredHash)}\n`,
			);
		} else {
			process.stdout.write(
				`${kleur.red("✗")} integrity MISMATCH: ${frameworkLabel}\n`,
			);
			process.stdout.write(`  declared : ${parsed.declaredHash}\n`);
			process.stdout.write(`  recomputed: ${recomputedHash}\n`);
			process.stdout.write(
				`  ${kleur.yellow("warning:")} this export has been altered after issuance OR was generated with a different formula.\n`,
			);
		}
	}

	return ok ? ExitCodes.ALLOWED : ExitCodes.BLOCKED;
}
