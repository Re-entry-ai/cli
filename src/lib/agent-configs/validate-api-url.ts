/**
 * Validate the API URL embedded into IDE config files.
 *
 * Why this exists: `apiUrl` is read from credentials.json and interpolated
 * into the config block we write to .mcp.json / .cursor/mcp.json alongside
 * the bearer token. If `apiUrl` is ever attacker-influenced (e.g., a
 * tampered credentials file or a phishing-domain that survived the device
 * flow), the bearer token gets transmitted to that host on every IDE
 * tool call.
 *
 * Defense: refuse to write a config that points at an untrusted host.
 * Localhost (any port) is allowed for development; everything else must
 * be HTTPS.
 *
 * The CLI's MCP `pre_commit_check` tool flagged this gap during the
 * v0.2 dogfood pass; this is the fix.
 */

export class InvalidApiUrlError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "InvalidApiUrlError";
	}
}

/**
 * Returns the parsed URL with a guaranteed-safe origin, or throws
 * `InvalidApiUrlError` with a user-readable explanation.
 *
 * Allowed:
 *   - https://*    (production / staging)
 *   - http://localhost   (any port)
 *   - http://127.0.0.1   (any port)
 *   - http://[::1]       (any port)
 *
 * Rejected:
 *   - Anything malformed (`new URL()` throws)
 *   - http:// to a non-localhost host (TLS-stripped MITM surface)
 *   - file://, ftp://, javascript:, data:, anything else
 */
export function validateApiUrl(input: string): URL {
	if (typeof input !== "string" || input.trim().length === 0) {
		throw new InvalidApiUrlError(
			"apiUrl is empty — cannot write IDE config without a backend URL.",
		);
	}

	let parsed: URL;
	try {
		parsed = new URL(input);
	} catch {
		throw new InvalidApiUrlError(
			`apiUrl is malformed: "${input}". Expected an https:// URL (or http://localhost for development).`,
		);
	}

	if (parsed.protocol === "https:") {
		return parsed;
	}

	if (parsed.protocol === "http:" && isLocalhost(parsed.hostname)) {
		return parsed;
	}

	throw new InvalidApiUrlError(
		`apiUrl scheme/host not allowed: "${input}". The CLI refuses to embed bearer tokens in config files unless the backend is reachable via https:// or http://localhost. If you intentionally want a custom backend, run the device-flow login against it first so credentials.json reflects the trusted URL.`,
	);
}

/**
 * Build the full MCP endpoint URL from an apiUrl.
 *
 * Both Claude Code and Cursor writers used to inline this; that drifted as
 * we added path-preservation for reverse-proxy deployments. Single source
 * of truth so the assembly rule lives in one place — extracted in v0.2.1
 * after the dogfood flagged the duplication.
 *
 * Examples:
 *   "https://api.re-entry.ai"          → "https://api.re-entry.ai/mcp"
 *   "https://api.re-entry.ai/"         → "https://api.re-entry.ai/mcp"
 *   "https://gateway.example.com/r"    → "https://gateway.example.com/r/mcp"
 *   "https://gateway.example.com/r/"   → "https://gateway.example.com/r/mcp"
 *   "http://localhost:3003"            → "http://localhost:3003/mcp"
 *
 * Throws `InvalidApiUrlError` on rejected input (see `validateApiUrl`).
 */
export function toMcpUrl(apiUrl: string): string {
  const url = validateApiUrl(apiUrl);
  const base = `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  return `${base}/mcp`;
}

function isLocalhost(hostname: string): boolean {
	// Strip IPv6 brackets ("[::1]" → "::1").
	const h = hostname.replace(/^\[/, "").replace(/\]$/, "");
	return h === "localhost" || h === "127.0.0.1" || h === "::1";
}
