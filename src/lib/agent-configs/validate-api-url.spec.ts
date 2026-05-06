import { validateApiUrl, InvalidApiUrlError } from './validate-api-url';

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

    it('https URL with trailing path (origin only used)', () => {
      const url = validateApiUrl('https://api.re-entry.ai/some/path');
      expect(url.origin).toBe('https://api.re-entry.ai');
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
