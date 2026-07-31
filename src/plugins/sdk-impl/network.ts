// plugins/sdk-impl/network.ts — fetch namespace (manifest-gated).
//
// Plugin calls `revyme.fetch(url, init)`. The host validates the URL's
// origin against the plugin's `network:` permissions, runs the fetch,
// and returns a serialized `{ status, headers, body }` payload. The
// SDK proxy reconstructs a real `Response` on the plugin side so
// plugin code can use `res.text()` / `res.json()` like a normal
// fetch.
//
// Origin matching:
//   - exact:    `network:api.openai.com`
//   - wildcard: `network:*.openai.com` matches any subdomain
//   - global:   `network:*` allows any origin (warn loudly at install)

import type { RpcHandler } from '../plugin-types';

function isOriginAllowed(perms: string[], hostname: string): boolean {
  for (const perm of perms) {
    if (!perm.startsWith('network:')) continue;
    const pattern = perm.slice('network:'.length);
    if (pattern === '*') return true;
    if (pattern === hostname) return true;
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(2);
      if (hostname === suffix || hostname.endsWith('.' + suffix)) return true;
    }
  }
  return false;
}

export const networkHandlers: Record<string, RpcHandler> = {
  'fetch': async (params, ctx): Promise<{ status: number; headers: Record<string, string>; body: string }> => {
    const p = params as { url?: unknown; init?: RequestInit };
    if (typeof p?.url !== 'string') throw new Error('fetch: url required');
    const u = new URL(p.url);
    if (!isOriginAllowed(ctx.manifest.permissions, u.hostname)) {
      throw new Error(
        `NETWORK_DENIED:${u.hostname} — plugin's manifest must declare ` +
          `\`network:${u.hostname}\` (or a wildcard) to call this origin`,
      );
    }
    const res = await fetch(p.url, p.init);
    const body = await res.text();
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => { headers[k] = v; });
    return { status: res.status, headers, body };
  },
};
