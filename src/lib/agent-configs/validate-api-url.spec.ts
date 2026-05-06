import {
  validateApiUrl,
  toMcpUrl,
  InvalidApiUrlError,
} from './validate-api-url';

describe('validateApiUrl', () => {
  describe('accepts', () => {
    it('https URL with default port', () => {
      const url = validateApiUrl('https://api.re-entry.ai');
      expect(url.origin).toBe('https://api.re-entry.ai');
    });

    it('https URL with explicit port', () => {
      const url = validateApiUrl('https://api.re-entry.ai:8443');
      expect(url.origin).toBe('https://api.re-entry.ai:8443');
    });

    it('https URL with path prefix — pathname preserved (reverse-proxy)', () => {
      const url = validateApiUrl('https://gateway.example.com/reentry');
      expect(url.origin).toBe('https://gateway.example.com');
      expect(url.pathname).toBe('/reentry');
      // The buildEntry helpers in claude-code.ts and cursor.ts read
      // `${origin}${pathname}` so the final URL becomes:
      //   https://gateway.example.com/reentry/mcp
      // — preserving the proxy path. This case pins that contract.
      expect(`${url.origin}${url.pathname.replace(/\/+$/, '')}/mcp`).toBe(
        'https://gateway.example.com/reentry/mcp',
      );
    });

    it('https URL with trailing slash on path — slash dropped before /mcp', () => {
      const url = validateApiUrl('https://gateway.example.com/reentry/');
      expect(`${url.origin}${url.pathname.replace(/\/+$/, '')}/mcp`).toBe(
        'https://gateway.example.com/reentry/mcp',
      );
    });

    it('bare https URL — pathname is "/" but no extra slash before /mcp', () => {
      const url = validateApiUrl('https://api.re-entry.ai');
      expect(`${url.origin}${url.pathname.replace(/\/+$/, '')}/mcp`).toBe(
        'https://api.re-entry.ai/mcp',
      );
    });

    it('http://localhost (any port) — dev workflow', () => {
      expect(validateApiUrl('http://localhost:3003').origin).toBe(
        'http://localhost:3003',
      );
      expect(validateApiUrl('http://localhost:8080').origin).toBe(
        'http://localhost:8080',
      );
    });

    it('http://127.0.0.1 (any port)', () => {
      expect(validateApiUrl('http://127.0.0.1:3003').origin).toBe(
        'http://127.0.0.1:3003',
      );
    });

    it('http://[::1] IPv6 loopback', () => {
      expect(validateApiUrl('http://[::1]:3003').origin).toBe('http://[::1]:3003');
    });
  });

  describe('rejects', () => {
    it('http:// to a non-localhost host (TLS-stripping risk)', () => {
      expect(() => validateApiUrl('http://api.attacker.com')).toThrow(
        InvalidApiUrlError,
      );
      expect(() => validateApiUrl('http://example.com')).toThrow(
        InvalidApiUrlError,
      );
    });

    it('file:// scheme', () => {
      expect(() => validateApiUrl('file:///etc/passwd')).toThrow(
        InvalidApiUrlError,
      );
    });

    it('ftp:// scheme', () => {
      expect(() => validateApiUrl('ftp://example.com')).toThrow(
        InvalidApiUrlError,
      );
    });

    it('javascript: pseudo-scheme', () => {
      expect(() => validateApiUrl('javascript:alert(1)')).toThrow(
        InvalidApiUrlError,
      );
    });

    it('data: pseudo-scheme', () => {
      expect(() => validateApiUrl('data:text/plain,hello')).toThrow(
        InvalidApiUrlError,
      );
    });

    it('empty string', () => {
      expect(() => validateApiUrl('')).toThrow(InvalidApiUrlError);
    });

    it('whitespace-only string', () => {
      expect(() => validateApiUrl('   ')).toThrow(InvalidApiUrlError);
    });

    it('non-string (defensive)', () => {
      expect(() => validateApiUrl(undefined as unknown as string)).toThrow(
        InvalidApiUrlError,
      );
      expect(() => validateApiUrl(null as unknown as string)).toThrow(
        InvalidApiUrlError,
      );
    });

    it('malformed URL', () => {
      expect(() => validateApiUrl('not-a-url')).toThrow(InvalidApiUrlError);
      expect(() => validateApiUrl('https://')).toThrow(InvalidApiUrlError);
    });
  });

  describe('toMcpUrl (single source of truth for MCP endpoint assembly)', () => {
    it('bare https URL', () => {
      expect(toMcpUrl('https://api.re-entry.ai')).toBe(
        'https://api.re-entry.ai/mcp',
      );
    });

    it('https URL with trailing slash', () => {
      expect(toMcpUrl('https://api.re-entry.ai/')).toBe(
        'https://api.re-entry.ai/mcp',
      );
    });

    it('https URL with path prefix (reverse-proxy)', () => {
      expect(toMcpUrl('https://gateway.example.com/reentry')).toBe(
        'https://gateway.example.com/reentry/mcp',
      );
    });

    it('https URL with path prefix and trailing slash', () => {
      expect(toMcpUrl('https://gateway.example.com/reentry/')).toBe(
        'https://gateway.example.com/reentry/mcp',
      );
    });

    it('localhost dev URL', () => {
      expect(toMcpUrl('http://localhost:3003')).toBe(
        'http://localhost:3003/mcp',
      );
    });

    it('rejects invalid URLs (delegates to validateApiUrl)', () => {
      expect(() => toMcpUrl('http://api.attacker.com')).toThrow(
        InvalidApiUrlError,
      );
      expect(() => toMcpUrl('not-a-url')).toThrow(InvalidApiUrlError);
    });
  });

  describe('error message', () => {
    it('includes the offending URL so the user knows what to fix', () => {
      try {
        validateApiUrl('http://api.attacker.com');
        fail('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(InvalidApiUrlError);
        expect((err as Error).message).toContain('http://api.attacker.com');
      }
    });

    it('mentions the device-flow login as the recovery path', () => {
      try {
        validateApiUrl('http://api.attacker.com');
      } catch (err) {
        expect((err as Error).message).toMatch(/device-flow|credentials/i);
      }
    });
  });
});
