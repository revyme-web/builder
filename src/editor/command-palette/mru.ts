// mru.ts — Most-recently-used tracking for cmd+K rows.
//
// Two jobs:
//   1. Rank boost — the thing you inserted 30 seconds ago is very likely
//      the thing you want again, so recent ids score above equally-good
//      matches that have never been used.
//   2. Empty-query view — opening the palette shows what you actually
//      reach for, instead of a fixed list of entry points.
//
// Stored as bare ids in localStorage. Ids are stable and derived from
// file paths / command names (`lib:component:components/Hero.tsx`), so a
// stale entry for a deleted file simply never resolves against the live
// item list and is ignored — no invalidation needed on delete.
//
// Deliberately NOT an atom: the ranker is a pure function called from a
// debounced effect, and making this reactive would re-run search on every
// activation for no visible benefit.

import { trace } from '@/shared/debug-trace';

const STORAGE_KEY = 'revyme:palette:mru';

/** Keep the tail bounded — beyond ~20 the boost is noise, and the empty
 *  view only ever renders the first handful. */
const MAX_ENTRIES = 20;

let cache: string[] | null = null;

function read(): string[] {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    cache = Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    // Private-mode localStorage, quota, or corrupt JSON. MRU is a nicety;
    // never let it break the palette.
    cache = [];
  }
  return cache;
}

/** Recently activated row ids, most recent first. */
export function getRecentIds(): string[] {
  return read();
}

/** Record an activation. Moves an existing id to the front rather than
 *  duplicating it, so repeat use keeps something at the top. */
export function recordRecent(id: string): void {
  const next = [id, ...read().filter((x) => x !== id)].slice(0, MAX_ENTRIES);
  cache = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Non-fatal — the in-memory cache still serves this session.
    trace.error('palette:mru-persist-failed', { id });
  }
}

/** Test seam — drops the in-memory cache and the persisted list. */
export function __resetMru(): void {
  cache = null;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* nothing to clear */
  }
}
