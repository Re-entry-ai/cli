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

// ANSI / C1 escape sequences (CSI, OSC, SS3, DCS, etc.)
const ANSI_ESCAPE_PATTERN =
  // eslint-disable-next-line no-control-regex
  /[\x1b\x9b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\x07)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PRZcf-ntqry=><~]))/g;

// C0 control characters except \t, \n. Also DEL, plus C1 control range.
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
  const s = String(input);
  return s.replace(ANSI_ESCAPE_PATTERN, '').replace(CONTROL_CHARS_PATTERN, '');
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
