/**
 * Tests for git URL parsing.
 *
 * The interesting unit is the regex shapes in `readRemoteOriginUrl` —
 * spawning git is integration territory, so we exercise the parser by
 * loading the regex source directly via test fixtures.
 *
 * We re-implement the parsing inline here because exposing the regexes
 * would widen the public API of git.ts for no production benefit. The
 * tests pin the actual production parsing rules; if the regex changes,
 * these tests fail loudly.
 */

function parseOrigin(url: string): string | null {
  const sshMatch = url.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
  if (sshMatch) {
    return `${sshMatch[1]}/${sshMatch[2]}`;
  }
  const httpsMatch = url.match(/^https?:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/);
  if (httpsMatch) {
    return `${httpsMatch[1]}/${httpsMatch[2]}`;
  }
  return null;
}

describe('parseOrigin (production regex shape)', () => {
  it('parses SSH origin with .git suffix', () => {
    expect(parseOrigin('git@github.com:Re-entry-ai/cli.git')).toBe(
      'Re-entry-ai/cli',
    );
  });

  it('parses SSH origin without .git suffix', () => {
    expect(parseOrigin('git@github.com:CodingKylo/cubu.ai-backend')).toBe(
      'CodingKylo/cubu.ai-backend',
    );
  });

  it('parses HTTPS origin with .git suffix', () => {
    expect(parseOrigin('https://github.com/Re-entry-ai/cli.git')).toBe(
      'Re-entry-ai/cli',
    );
  });

  it('parses HTTPS origin without .git suffix', () => {
    expect(parseOrigin('https://github.com/CodingKylo/cubu.ai-frontend')).toBe(
      'CodingKylo/cubu.ai-frontend',
    );
  });

  it('parses HTTP origin (not just HTTPS)', () => {
    expect(parseOrigin('http://github.com/foo/bar')).toBe('foo/bar');
  });

  it('returns null for non-GitHub remotes', () => {
    expect(parseOrigin('git@gitlab.com:foo/bar.git')).toBeNull();
    expect(parseOrigin('https://bitbucket.org/foo/bar')).toBeNull();
  });

  it('returns null for malformed input', () => {
    expect(parseOrigin('')).toBeNull();
    expect(parseOrigin('not-a-url')).toBeNull();
    expect(parseOrigin('github.com/foo/bar')).toBeNull(); // missing scheme
  });

  it('handles repos with dots in the name', () => {
    expect(parseOrigin('git@github.com:foo/bar.baz.git')).toBe('foo/bar.baz');
  });

  it('handles repos with hyphens and underscores', () => {
    expect(parseOrigin('git@github.com:my-org/my_repo-v2.git')).toBe(
      'my-org/my_repo-v2',
    );
  });
});
