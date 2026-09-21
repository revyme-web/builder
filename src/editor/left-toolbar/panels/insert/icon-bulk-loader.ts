// icon-bulk-loader.ts — icon artwork for the Insert > Icons grid, fetched in
// BULK instead of one request per icon.
//
// The grid used to render `<img src="api.iconify.design/<icon>.svg">` per cell
// AND prefetch a second per-icon SVG for the drag payload — two requests per
// icon, and the prefetch fired for EVERY mounted cell at once, lazy-loading or
// not. A pack view mounts the whole pack (1,402 cells for Font Awesome 6 Solid,
// 10k+ for Material Symbols), so opening one burst thousands of requests at the
// public API, which answers 429 Too Many Requests: the pack title and count
// loaded (one request) and every thumbnail came back broken (user report
// 2026-09-21, "a lot of the packs are just not loading anymore").
//
// Iconify's JSON endpoint returns MANY icons per request
// (`/<prefix>.json?icons=a,b,c`), and the same body serves both the thumbnail
// and the drag payload. Requests are queued for a tick, grouped per prefix,
// chunked to stay under the API's URL-length guidance, and capped in parallel.

export interface IconData {
  /** Inner SVG markup (no <svg> root). */
  body: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The slice of an Iconify JSON response this module reads. */
export interface IconifyJsonResponse {
  prefix?: string;
  icons?: Record<string, { body: string; left?: number; top?: number; width?: number; height?: number }>;
  aliases?: Record<string, { parent: string; hFlip?: boolean; vFlip?: boolean; rotate?: number }>;
  left?: number;
  top?: number;
  width?: number;
  height?: number;
  not_found?: string[];
}

/** Iconify's default viewBox size when a set declares none. */
const DEFAULT_SIZE = 16;

/** Keep the `icons=` list comfortably inside the ~500-char URL guidance. */
const MAX_NAMES_CHARS = 400;

/** Polite parallelism — the point of this module is NOT to burst the API. */
const MAX_PARALLEL = 3;

/** Split names into chunks whose comma-joined length stays under the cap. */
export function chunkIconNames(names: readonly string[], maxChars = MAX_NAMES_CHARS): string[][] {
  const chunks: string[][] = [];
  let cur: string[] = [];
  let len = 0;
  for (const n of names) {
    const next = cur.length ? len + 1 + n.length : n.length;
    if (cur.length && next > maxChars) {
      chunks.push(cur);
      cur = [n];
      len = n.length;
    } else {
      cur.push(n);
      len = next;
    }
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

/**
 * Icons from one JSON response, by local name. `null` = the API has no such
 * icon (or only reaches it through a TRANSFORMED alias — hFlip / vFlip /
 * rotate — which this flat body can't express; those fall back to the per-icon
 * SVG endpoint, one request, rare).
 */
export function parseIconifyJson(requested: readonly string[], json: IconifyJsonResponse): Map<string, IconData | null> {
  const out = new Map<string, IconData | null>();
  const icons = json.icons ?? {};
  const aliases = json.aliases ?? {};
  const resolve = (name: string, depth = 0): IconData | null => {
    const direct = icons[name];
    if (direct) {
      return {
        body: direct.body,
        left: direct.left ?? json.left ?? 0,
        top: direct.top ?? json.top ?? 0,
        width: direct.width ?? json.width ?? DEFAULT_SIZE,
        height: direct.height ?? json.height ?? DEFAULT_SIZE,
      };
    }
    const alias = aliases[name];
    if (!alias || depth > 4) return null;
    if (alias.hFlip || alias.vFlip || alias.rotate) return null;
    return resolve(alias.parent, depth + 1);
  };
  for (const name of requested) out.set(name, resolve(name));
  return out;
}

/** A thumbnail-ready data URI — drop-in for the old per-icon `<img src>`. */
export function iconDataUri(d: IconData): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${d.left} ${d.top} ${d.width} ${d.height}">${d.body}</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

// ─── The queue ──────────────────────────────────────────────────────────────

const cache = new Map<string, Promise<IconData | null>>();
const resolved = new Map<string, IconData | null>();
const waiting = new Map<string, Array<(d: IconData | null) => void>>();
let pending = new Set<string>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let inFlight = 0;
const backlog: Array<() => Promise<void>> = [];

function pump(): void {
  while (inFlight < MAX_PARALLEL && backlog.length) {
    const job = backlog.shift()!;
    inFlight++;
    void job().finally(() => { inFlight--; pump(); });
  }
}

function settle(full: string, data: IconData | null): void {
  resolved.set(full, data);
  const list = waiting.get(full);
  waiting.delete(full);
  if (list) for (const fn of list) fn(data);
}

/** The per-icon SVG endpoint, for the rare transformed alias. */
async function fetchSingle(full: string): Promise<IconData | null> {
  try {
    const res = await fetch(`https://api.iconify.design/${full}.svg`);
    if (!res.ok) return null;
    const text = await res.text();
    const vb = text.match(/viewBox="([^"]+)"/)?.[1]?.split(/\s+/).map(Number);
    const inner = text.match(/<svg[^>]*>([\s\S]*)<\/svg>/)?.[1];
    if (!inner) return null;
    const [left = 0, top = 0, width = 24, height = 24] = vb ?? [];
    return { body: inner.trim(), left, top, width, height };
  } catch {
    return null;
  }
}

function flush(): void {
  flushTimer = null;
  const names = [...pending];
  pending = new Set();
  const byPrefix = new Map<string, string[]>();
  for (const full of names) {
    const i = full.indexOf(':');
    if (i <= 0) { settle(full, null); continue; }
    const prefix = full.slice(0, i);
    let list = byPrefix.get(prefix);
    if (!list) { list = []; byPrefix.set(prefix, list); }
    list.push(full.slice(i + 1));
  }
  for (const [prefix, locals] of byPrefix) {
    for (const chunk of chunkIconNames(locals)) {
      backlog.push(async () => {
        let parsed: Map<string, IconData | null> | null = null;
        try {
          const res = await fetch(`https://api.iconify.design/${prefix}.json?icons=${chunk.map(encodeURIComponent).join(',')}`);
          if (res.ok) parsed = parseIconifyJson(chunk, (await res.json()) as IconifyJsonResponse);
        } catch { /* network failure — every icon in the chunk settles null */ }
        for (const local of chunk) {
          const full = `${prefix}:${local}`;
          if (!parsed) {
            // The REQUEST failed (offline, 429…) — that says nothing about the
            // icon. Settle this waiter empty but forget the entry, so the next
            // mount retries instead of showing a blank for the whole session.
            settle(full, null);
            cache.delete(full);
            resolved.delete(full);
            continue;
          }
          const data = parsed.get(local) ?? null;
          if (data) { settle(full, data); continue; }
          // Known to the API but not expressible flat (transformed alias) or
          // genuinely missing — one single-icon attempt settles it either way.
          settle(full, await fetchSingle(full));
        }
      });
    }
  }
  pump();
}

/** Artwork for one icon (`prefix:name`). Batched with every other request made
 *  in the same tick; cached for the session. */
export function loadIconData(full: string): Promise<IconData | null> {
  const hit = cache.get(full);
  if (hit) return hit;
  const promise = new Promise<IconData | null>((resolve) => {
    const list = waiting.get(full) ?? [];
    list.push(resolve);
    waiting.set(full, list);
  });
  cache.set(full, promise);
  pending.add(full);
  if (!flushTimer) flushTimer = setTimeout(flush, 40);
  return promise;
}

/** Sync peek — pointerdown handlers can't await. `undefined` = not loaded yet. */
export function peekIconData(full: string): IconData | null | undefined {
  return resolved.get(full);
}
