/**
 * Tests for the terminal-output sanitizer.
 *
 * Threat model: every string we print from review/fixes/log/rules originates
 * in the backend, fed by an LLM analyzing diff text the user does not
 * control end-to-end. ANSI escapes or control characters in that content
 * could move the cursor, clear the screen, render fake hyperlinks (OSC 8),
 * or trigger terminal-specific behavior. We strip them.
 *
 * If any of these tests fail, the sanitizer has regressed and CLI output
 * is no longer safe. Treat regressions here as security regressions.
 */

import { safeText, safeTextArray } from './safe-print';

describe('safeText', () => {
  describe('preserves safe content', () => {
    it('passes plain ASCII through unchanged', () => {
      expect(safeText('Hello, world!')).toBe('Hello, world!');
    });

    it('preserves newlines (\\n) and tabs (\\t)', () => {
      expect(safeText('line one\nline two\tcolumn')).toBe(
        'line one\nline two\tcolumn',
      );
    });

    it('passes Unicode through (em-dash, accented chars, emoji)', () => {
      expect(safeText('café — naïve résumé 🎉')).toBe('café — naïve résumé 🎉');
    });

    it('passes multi-line code blocks through', () => {
      const codeBlock =
        'function foo() {\n  return 42;\n}\n// comment with TODO';
      expect(safeText(codeBlock)).toBe(codeBlock);
    });
  });

  describe('strips ANSI escape sequences (CSI / SGR)', () => {
    it('strips standalone color reset (\\x1b[0m)', () => {
      expect(safeText('\x1b[0m')).toBe('');
    });

    it('strips foreground color set (\\x1b[31m)', () => {
      expect(safeText('\x1b[31mred text\x1b[0m')).toBe('red text');
    });

    it('strips bold + color combos', () => {
      expect(safeText('\x1b[1;31mBOLD RED\x1b[0m normal')).toBe(
        'BOLD RED normal',
      );
    });

    it('strips cursor-movement sequences (cursor up, line erase)', () => {
      // \x1b[2A = cursor up 2 lines, \x1b[2K = erase entire line.
      // An attacker could use these to overwrite a security warning that
      // was just printed. Must be stripped.
      expect(safeText('SAFE\x1b[2A\x1b[2KOVERWRITE')).toBe('SAFEOVERWRITE');
    });

    it('strips screen-clear sequences (\\x1b[2J, \\x1bc)', () => {
      expect(safeText('\x1b[2Jcleared')).toBe('cleared');
    });

    it('strips OSC hyperlink sequences (\\x1b]8;;URL\\x07TEXT\\x1b]8;;\\x07)', () => {
      // OSC 8 lets terminals render text as a clickable hyperlink to an
      // arbitrary URL. An attacker could disguise a malicious URL as
      // benign text. Strip the escape; preserve the visible text.
      const osc =
        '\x1b]8;;https://attacker.example.com\x07benign-looking text\x1b]8;;\x07';
      const sanitized = safeText(osc);
      expect(sanitized).not.toContain('\x1b');
      expect(sanitized).not.toContain('attacker.example.com');
      expect(sanitized).toContain('benign-looking text');
    });
  });

  describe('strips control characters', () => {
    it('strips bell (\\x07)', () => {
      expect(safeText('alert\x07!')).toBe('alert!');
    });

    it('strips backspace (\\x08)', () => {
      // Backspace can be used to overwrite previously printed characters
      // (the "lying" attack: print "FAIL\b\b\b\bPASS" → looks like PASS).
      expect(safeText('FAIL\x08\x08\x08\x08PASS')).toBe('FAILPASS');
    });

    it('strips vertical tab and form feed', () => {
      expect(safeText('a\x0bb\x0cc')).toBe('abc');
    });

    it('strips null byte (\\x00)', () => {
      expect(safeText('hello\x00world')).toBe('helloworld');
    });

    it('strips DEL (\\x7f)', () => {
      expect(safeText('a\x7fb')).toBe('ab');
    });

    it('strips C1 control chars (\\x80-\\x9f)', () => {
      // C1 range — historical 8-bit control codes that some terminals
      // still interpret. CSI introducer at \x9b is particularly dangerous.
      // We strip the C1 byte itself; the parameter bytes that followed
      // (e.g., '31m') become inert printable text without their introducer.
      const result = safeText('safe\x9b31m no');
      expect(result).not.toContain('\x9b');
      expect(result).toContain('safe');
      expect(result).toContain(' no');
    });

    it('strips bare CSI introducer (\\x9b)', () => {
      // Some terminals interpret \x9b as an alternate CSI introducer
      // (skipping the \x1b[). The C1 range strip removes the introducer;
      // residual chars become printable text.
      const sneaky = `before\x9b2K after`;
      const result = safeText(sneaky);
      expect(result).not.toContain('\x9b');
      expect(result.startsWith('before')).toBe(true);
      expect(result.endsWith(' after')).toBe(true);
    });
  });

  describe('handles non-string input defensively', () => {
    it('returns empty string for null', () => {
      expect(safeText(null)).toBe('');
    });

    it('returns empty string for undefined', () => {
      expect(safeText(undefined)).toBe('');
    });

    it('coerces numbers to string then sanitizes', () => {
      expect(safeText(42)).toBe('42');
    });

    it('coerces booleans to string', () => {
      expect(safeText(true)).toBe('true');
    });

    it('coerces objects via String()', () => {
      // Acceptable; caller should prefer typeof checks before passing.
      expect(safeText({ foo: 'bar' })).toBe('[object Object]');
    });
  });

  describe('idempotency', () => {
    it('safeText(safeText(x)) === safeText(x)', () => {
      const inputs = [
        'plain',
        '\x1b[31mred\x1b[0m',
        'a\x07b\x08c\x09d\x7fe',
        'café\x9b31m',
      ];
      for (const input of inputs) {
        const once = safeText(input);
        const twice = safeText(once);
        expect(twice).toBe(once);
      }
    });
  });
});

describe('safeTextArray', () => {
  it('sanitizes every element of an array', () => {
    expect(safeTextArray(['\x1b[31mred', 'plain', 'bell\x07'])).toEqual([
      'red',
      'plain',
      'bell',
    ]);
  });

  it('returns empty array for non-array input', () => {
    expect(safeTextArray(null)).toEqual([]);
    expect(safeTextArray(undefined)).toEqual([]);
    expect(safeTextArray('not an array')).toEqual([]);
    expect(safeTextArray(42)).toEqual([]);
  });

  it('replaces non-string entries with empty strings', () => {
    expect(safeTextArray(['ok', 42, null, 'fine'])).toEqual([
      'ok',
      '42',
      '',
      'fine',
    ]);
  });
});
