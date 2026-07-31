// plugins/sdk-impl/redirects.ts — redirects.* namespace.
//
// Site-wide URL redirects, stored as a JSON array at
// `app/_redirects.json`. The publish pipeline reads this file at
// export time and emits a `_redirects` (Netlify) / `next.config.js`
// rewrite block (Next.js).
//
// Order matters — the array's order IS the redirect priority. First
// match wins.

import { getDefaultStore } from 'jotai';
import { projectFS, projectVersionAtom } from '@/code/project/project-fs';
import type { Redirect } from '@revyme/plugin-sdk';
import type { RpcHandler } from '../plugin-types';

const store = getDefaultStore();
const FILE = 'app/_redirects.json';

function readRedirects(): Redirect[] {
  const raw = projectFS.readFile(FILE);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (r): r is Redirect =>
        r && typeof r === 'object' &&
        typeof r.id === 'string' && typeof r.from === 'string' && typeof r.to === 'string',
    );
  } catch {
    return [];
  }
}

function writeRedirects(redirects: Redirect[]): void {
  projectFS.writeFile(FILE, JSON.stringify(redirects, null, 2));
  store.set(projectVersionAtom, (v) => v + 1);
}

let counter = 0;
function makeRedirectId(): string {
  counter += 1;
  return `redir-${Date.now().toString(36)}-${counter}`;
}

export const redirectsHandlers: Record<string, RpcHandler> = {
  'redirects.list': async (): Promise<Redirect[]> => readRedirects(),

  'redirects.add': async (params): Promise<string[]> => {
    const p = params as { redirects?: unknown };
    if (!Array.isArray(p?.redirects)) throw new Error('redirects.add: redirects[] required');
    const current = readRedirects();
    const ids: string[] = [];
    for (const r of p.redirects) {
      if (!r || typeof r !== 'object') continue;
      const rr = r as { from?: string; to?: string; expandToAllLocales?: boolean };
      if (typeof rr.from !== 'string' || typeof rr.to !== 'string') continue;
      const id = makeRedirectId();
      current.push({
        id,
        from: rr.from,
        to: rr.to,
        expandToAllLocales: rr.expandToAllLocales ?? false,
      });
      ids.push(id);
    }
    writeRedirects(current);
    return ids;
  },

  'redirects.remove': async (params): Promise<void> => {
    const p = params as { redirectIds?: unknown };
    if (!Array.isArray(p?.redirectIds)) throw new Error('redirects.remove: redirectIds[] required');
    const drop = new Set(p.redirectIds as string[]);
    writeRedirects(readRedirects().filter((r) => !drop.has(r.id)));
  },

  'redirects.setOrder': async (params): Promise<void> => {
    const p = params as { redirectIds?: unknown };
    if (!Array.isArray(p?.redirectIds)) throw new Error('redirects.setOrder: redirectIds[] required');
    const order = new Map<string, number>();
    (p.redirectIds as string[]).forEach((id, i) => order.set(id, i));
    const sorted = [...readRedirects()].sort(
      (a, b) => (order.get(a.id) ?? 999) - (order.get(b.id) ?? 999),
    );
    writeRedirects(sorted);
  },
};
