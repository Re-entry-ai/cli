import * as fs from "fs";
import * as path from "path";

/**
 * Read a JSON file as a plain object, returning {} if the file doesn't exist
 * and throwing on parse failure (we don't want to silently overwrite a
 * corrupt user config — better to fail loudly so the user backs it up
 * themselves).
 */
export function readJsonObject(filePath: string): Record<string, unknown> {
	let raw: string;
	try {
		raw = fs.readFileSync(filePath, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			return {};
		}
		throw err;
	}

	// Empty file is treated as empty object.
	if (raw.trim().length === 0) {
		return {};
	}

	const parsed = JSON.parse(raw);
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(
			`${filePath} is not a JSON object — refusing to merge. Move the file aside and re-run.`,
		);
	}
	return parsed as Record<string, unknown>;
}

/**
 * Atomically write a JSON object to disk. Creates parent directory and a
 * one-ring backup at `<path>.reentry-bak` before overwriting. Mirrors the
 * write-to-tmp + rename pattern used by storage.ts for credentials.
 */
export function writeJsonObjectAtomic(
	filePath: string,
	value: Record<string, unknown>,
): void {
	const dir = path.dirname(filePath);
	fs.mkdirSync(dir, { recursive: true });

	// Backup the existing file once before we overwrite. Single-ring; the
	// previous .reentry-bak is overwritten so we don't leak backups over time.
	if (fs.existsSync(filePath)) {
		try {
			fs.copyFileSync(filePath, `${filePath}.reentry-bak`);
		} catch {
			// Backup failure is not fatal — we still want to attempt the write.
		}
	}

	const tmp = `${filePath}.${process.pid}.tmp`;
	const fd = fs.openSync(tmp, "wx", 0o600);
	try {
		fs.writeFileSync(fd, JSON.stringify(value, null, 2) + "\n", {
			encoding: "utf8",
		});
	} finally {
		fs.closeSync(fd);
	}
	fs.renameSync(tmp, filePath);
}

/**
 * Compare two JSON-ish values for deep equality. Used to decide whether
 * a re-install is a no-op (idempotent) or a stale-config replacement
 * that requires --force.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) {
		return true;
	}
	if (a === null || b === null) {
		return a === b;
	}
	if (typeof a !== "object" || typeof b !== "object") {
		return false;
	}
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
			return false;
		}
		for (let i = 0; i < a.length; i++) {
			if (!deepEqual(a[i], b[i])) {
				return false;
			}
		}
		return true;
	}
	const aKeys = Object.keys(a as Record<string, unknown>).sort();
	const bKeys = Object.keys(b as Record<string, unknown>).sort();
	if (aKeys.length !== bKeys.length) {
		return false;
	}
	for (let i = 0; i < aKeys.length; i++) {
		if (aKeys[i] !== bKeys[i]) {
			return false;
		}
		if (
			!deepEqual(
				(a as Record<string, unknown>)[aKeys[i]],
				(b as Record<string, unknown>)[bKeys[i]],
			)
		) {
			return false;
		}
	}
	return true;
}
