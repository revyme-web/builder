// dev-server-guards.test.ts — security report 2026-11-06: the dev server's
// `/__debug_code` and `/__debug_project` took file paths from the request
// (`../` wrote anywhere) with no auth, and the sandbox / preview servers
// answered every website's CORS request.
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { editorCorsOrigins, isInsideDir, isPlainFileName, isTrustedDebugRequest } from './dev-server-guards';

describe('isTrustedDebugRequest', () => {
  it('accepts the editor on this machine (same-origin browser request)', () => {
    expect(isTrustedDebugRequest('127.0.0.1', 'same-origin')).toBe(true);
    expect(isTrustedDebugRequest('::1', 'same-origin')).toBe(true);
    expect(isTrustedDebugRequest('::ffff:127.0.0.1', 'same-origin')).toBe(true);
  });

  it('accepts a non-browser request on this machine (no Sec-Fetch-Site)', () => {
    expect(isTrustedDebugRequest('127.0.0.1', undefined)).toBe(true);
  });

  it('refuses a website open in another tab', () => {
    expect(isTrustedDebugRequest('127.0.0.1', 'cross-site')).toBe(false);
    expect(isTrustedDebugRequest('127.0.0.1', 'same-site')).toBe(false);
  });

  it('refuses another device on the network', () => {
    expect(isTrustedDebugRequest('192.168.1.20', 'same-origin')).toBe(false);
    expect(isTrustedDebugRequest('10.0.0.5', undefined)).toBe(false);
    expect(isTrustedDebugRequest(undefined, undefined)).toBe(false);
  });
});

describe('isPlainFileName', () => {
  it('accepts the names the debug toolbar sends', () => {
    expect(isPlainFileName('debug-code.jsx')).toBe(true);
    expect(isPlainFileName('debug-code-before.jsx')).toBe(true);
  });

  it('refuses anything that is not one path segment', () => {
    for (const name of ['../x.js', '..', '.env', 'a/b.jsx', 'a\\b.jsx', '/etc/passwd', '', 'x'.repeat(200)]) {
      expect(isPlainFileName(name), name).toBe(false);
    }
  });
});

describe('isInsideDir', () => {
  const dir = path.resolve('/work/debug_output/project');
  const at = (rel: string) => path.resolve(dir, rel);

  it('accepts project paths', () => {
    expect(isInsideDir(dir, at('app/page.tsx'), path.sep)).toBe(true);
    expect(isInsideDir(dir, at('components/a/b.tsx'), path.sep)).toBe(true);
  });

  it('refuses paths that climb out, absolute paths and look-alike siblings', () => {
    expect(isInsideDir(dir, at('../../../.zshrc'), path.sep)).toBe(false);
    expect(isInsideDir(dir, at('/etc/hosts'), path.sep)).toBe(false);
    expect(isInsideDir(dir, at('../project-evil/x'), path.sep)).toBe(false);
    expect(isInsideDir(dir, dir, path.sep)).toBe(false);
  });
});

describe('editorCorsOrigins', () => {
  const allowed = (origin: string, hosts = ['revyme.com', '.revyme.com']) =>
    editorCorsOrigins(hosts).some((re) => re.test(origin));

  it('allows the editor in dev and on the deployed hosts', () => {
    expect(allowed('http://localhost:3333')).toBe(true);
    expect(allowed('http://127.0.0.1:3001')).toBe(true);
    expect(allowed('https://revyme.com')).toBe(true);
    expect(allowed('https://www.revyme.com')).toBe(true);
    expect(allowed('https://revyme.com:5174')).toBe(true);
  });

  it('refuses other websites, including look-alike domains', () => {
    expect(allowed('https://evil.example')).toBe(false);
    expect(allowed('https://revyme.com.evil.example')).toBe(false);
    expect(allowed('https://notrevyme.com')).toBe(false);
    expect(allowed('https://localhost.evil.example')).toBe(false);
  });

  it("follows a self-hoster's VITE_ALLOWED_HOSTS", () => {
    expect(allowed('https://builder.example.org', ['builder.example.org'])).toBe(true);
    expect(allowed('https://revyme.com', ['builder.example.org'])).toBe(false);
  });
});
