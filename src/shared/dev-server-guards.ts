// dev-server-guards.ts — checks used by the Vite configs: who may call the
// dev server's `/__debug_*` endpoints (vite.config.ts) and which origins may
// read the canvas sandbox / preview servers (vite.sandbox.config.ts,
// vite.preview.config.ts). Pure — no node imports — so the configs can import
// it and it is tested with the rest of src/.

/** The `/__debug_*` endpoints write files to this machine, so only the
 *  developer's own browser may call them: the request must arrive over
 *  loopback (directly or through the local dispatcher), and a browser request
 *  must be same-origin. Browsers stamp `Sec-Fetch-Site` and a page can't
 *  forge it, so a website open in another tab can't POST here; a request
 *  without it (curl on this machine) passes. */
export function isTrustedDebugRequest(
  remoteAddress: string | undefined,
  secFetchSite: string | string[] | undefined,
): boolean {
  const loopback = !!remoteAddress && (
    remoteAddress.startsWith('127.') || remoteAddress === '::1' || remoteAddress.startsWith('::ffff:127.')
  );
  if (!loopback) return false;
  return secFetchSite === undefined || secFetchSite === 'same-origin';
}

/** A file name a debug endpoint may write: one path segment — no separators,
 *  no `..`, no leading dot. */
export function isPlainFileName(name: string): boolean {
  return /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/.test(name);
}

/** `target` lies strictly inside `dir`. Both must already be resolved
 *  (`path.resolve`), so `..` segments are gone; `sep` is `path.sep`. */
export function isInsideDir(dir: string, target: string, sep: string): boolean {
  return target.startsWith(dir.endsWith(sep) ? dir : dir + sep);
}

/** CORS origins for the canvas sandbox (5174) and preview (5175) servers:
 *  the editor's own hosts — localhost on any port, plus each
 *  VITE_ALLOWED_HOSTS entry (`.example.com` = the domain and its subdomains)
 *  on any port. They were `cors: true`, which let any website read them. */
export function editorCorsOrigins(allowedHosts: string[]): RegExp[] {
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const hosts = allowedHosts
    .map((h) => h.trim())
    .filter((h) => h && h !== '.')
    .map((h) => (h.startsWith('.') ? `(?:[^/:]+\\.)?${escape(h.slice(1))}` : escape(h)));
  return [
    /^https?:\/\/(?:(?:[^/:]+\.)?localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/,
    ...hosts.map((h) => new RegExp(`^https?://${h}(?::\\d+)?$`)),
  ];
}
