/**
 * Sanitize a string before writing it to a terminal.
 *
 * Threat: every string we print from `review`, `fixes`, `log`, `rules`,
 * etc. originates in the backend, which is fed by an LLM analyzing diff
 * text the user does not control end-to-end. A malicious diff could
 * contain ANSI escape sequences or C0/C1 control characters that, if
 * passed verbatim to a terminal, can:
 *   - Move the cursor (overwrite previous output, including security warnings)
 *   - Clear the screen (hide what just happened)
 *   - Use OSC 8 hyperlink sequences to disguise URLs
 *   - Trigger terminal-specific behavior (xterm exec, iTerm2 image inline,
 *     etc. — varies by terminal but historically a real attack surface)
 *   - Inject bell characters / form feeds to obscure logs
 *
 * The fix is to strip everything that isn't printable text, newline, or tab
 * before any process.stdout.write(...) of LLM/MCP-derived content. Color
 * we apply via kleur is fine (kleur emits a known SGR sequence; we
 * sanitize the *content* only, not the wrapper).
 *
 * Use:
 *   process.stdout.write(`  ${kleur.bold(safeText(comment.body))}\n`);
 *
 * NOT:
 *   process.stdout.write(`  ${comment.body}\n`);
 */

// OSC (Operating System Command): `\x1b]<data>\x07` or `\x1b]<data>\x1b\\`.
// Includes payload (e.g., URLs in OSC 8 hyperlink). Must strip the WHOLE
// thing, not just the introducer — leaving the URL would defeat the
// sanitizer. Greedy-but-bounded: any non-control bytes up to the
// BEL or ESC-backslash terminator.
// eslint-disable-next-line no-control-regex
const OSC_PATTERN = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

// CSI (Control Sequence Introducer): `\x1b[<params><intermediates><final>`.
// Params are 0x30-0x3f, intermediates 0x20-0x2f, final byte 0x40-0x7e.
// eslint-disable-next-line no-control-regex
const CSI_PATTERN = /\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g;

// SS2/SS3, DCS, and other single-byte escape sequences:
// `\x1b<one of @A-Z\-_>`. Catches ESC followed by a Fe-range byte.
// eslint-disable-next-line no-control-regex
const ESC_PATTERN = /\x1b[\x40-\x5f]/g;

// Bare ESC that didn't match any of the above patterns above (defensive).
// eslint-disable-next-line no-control-regex
const BARE_ESC_PATTERN = /\x1b/g;

// C0 control characters except \t, \n. Plus DEL (0x7f). Plus C1 control
// range (0x80-0x9f) which some terminals still interpret as 8-bit
// equivalents of ESC sequences (notably 0x9b is bare CSI).
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_PATTERN = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

/**
 * Strip ANSI escape sequences and dangerous control characters from a
 * string. Preserves printable text, newline, and tab.
 *
 * Always use for any LLM/MCP-derived content. Kleur's own coloring goes
 * around the result, not through it.
 */
export function safeText(input: unknown): string {
  if (input === null || input === undefined) {
    return '';
  }
  const stringInput = String(input);
  // Order matters: strip multi-byte sequences first (OSC, CSI, ESC) so we
  // don't leave their payload behind when we then strip individual control
  // characters. Run twice as a defense against pathological inputs that
  // construct nested escape sequences.
  let sanitized = stringInput;
  for (let pass = 0; pass < 2; pass++) {
    sanitized = sanitized
      .replace(OSC_PATTERN, '')
      .replace(CSI_PATTERN, '')
      .replace(ESC_PATTERN, '')
      .replace(BARE_ESC_PATTERN, '')
      .replace(CONTROL_CHARS_PATTERN, '');
  }
  return sanitized;
}

/**
 * Same as safeText but for an array of strings. Returns the sanitized
 * array (preserves length and order). Non-string entries become ''.
 */
export function safeTextArray(input: unknown): string[] {
  if (!Array.isArray(input)) {
    return [];
  }
  return input.map(safeText);
}
