// preset-store.ts — Jotai atoms for design preset tokens (CSS custom properties).
// Tokens live in app/globals.css in ProjectFS.
// presetTokensAtom is DERIVED — reads from ProjectFS on every projectVersion change.
// This ensures undo/redo automatically updates all preset UI everywhere.

import { atom } from 'jotai';
import { projectFS, projectVersionAtom } from '../project/project-fs';
import { parsePresetTokens } from '../generation/preset-gen';
import { parseJSXToNodes } from '../parsing/parser';
import { trace } from '@/shared/debug-trace';
import type { PresetToken } from '@/shared/types';

const TOKENS_PATH = 'app/globals.css';

/** All preset tokens parsed from app/globals.css — derived from ProjectFS, auto-updates on version bump */
export const presetTokensAtom = atom<PresetToken[]>((get) => {
  // Subscribe to version so we re-read when files change (mutations, undo/redo, etc.)
  get(projectVersionAtom);
  const css = projectFS.readFile(TOKENS_PATH);
  if (!css) return [];
  return parsePresetTokens(css);
});

/** Live (uncommitted) override of a single preset token's value — shown by the
 *  React-rendered editor swatches (presets panel `ValuePreview` + the Fill row)
 *  WHILE the user drags a preset color picker. The canvas already previews live
 *  via `setCanvasTokenVar`; those swatches read the COMMITTED `presetTokensAtom`,
 *  so without this they'd lag until release. The preset edit panel sets it per
 *  frame and clears it once the commit re-derives `presetTokensAtom` (a version
 *  bump) — flicker-free, since by then the committed value equals the override. */
export const livePresetTokenAtom = atom<{ name: string; value: string } | null>(null);

// ─── Preset Usage ──────────────────────────────────────────────────────────

/** Where a single preset is being consumed: enough info for the usage popup
 *  to render a label AND navigate the canvas (switch file, select node,
 *  zoom-to-fit). */
export interface PresetUsage {
  filePath: string;
  fileLabel: string; // human-friendly label (e.g. 'Home', '/about', 'Hero.tsx')
  nodeId: string;
  nodeName: string;
}

/** Pure, file-map-driven preset usage scanner — extracted from the atom so
 *  it can be unit-tested without bootstrapping `projectFS`.
 *
 *  Strategy: walk the raw source for every `var(--token)` occurrence and use
 *  the AST to find the nearest enclosing JSX element's `data-id` for
 *  navigation context. This is robust to: variant objects (motionVariants),
 *  conditional ternaries, media-query overrides, motion props
 *  (whileHover/whileTap), nested style shorthands (border, gradient, …) —
 *  anywhere a string literal contains `var(--…)`. The parser-derived
 *  `node.styles` map only captures inline `style={{…}}` properties, which
 *  silently misses variant-object references and drove the original "no
 *  badge" bug.
 *
 *  Dedup is per (tokenName, nodeId) so a node referencing the same token
 *  in multiple style props counts once. Border / typography presets are
 *  compound (3+ tokens per visual preset); the panel UI aggregates at the
 *  group level — this scanner stays single-token. */
export function scanPresetUsage(files: Map<string, string>): Map<string, PresetUsage[]> {
  const result = new Map<string, PresetUsage[]>();
  // Layout files are merged into pages at parse time — walking them
  // independently would surface their nodes twice. Match by basename
  // (`layout.tsx`, `LayoutClient.tsx`) rather than substring `.includes`
  // so a folder named `layout-experiments/` doesn't accidentally hide
  // every page underneath it from the badge counts.
  const isLayoutFile = (p: string) => /\/(?:layout|LayoutClient)\.tsx$/.test(p);
  const targets = Array.from(files.keys()).filter((p) =>
    (p.startsWith('app/') && p.endsWith('.tsx') && !isLayoutFile(p)) ||
    (p.startsWith('components/') && p.endsWith('.tsx'))
  );

  for (const filePath of targets) {
    const code = files.get(filePath);
    if (!code) continue;

    const fileLabel = deriveFileLabel(filePath);

    let nodesByDataId: Map<string, { name: string; type: string }> | null = null;
    try {
      const parsed = parseJSXToNodes(code);
      nodesByDataId = new Map();
      for (const [id, n] of parsed) {
        nodesByDataId.set(id, { name: n.name || n.type || id, type: n.type });
      }
    } catch {
      // Parse failure — we still record the file-level usage so the
      // badge count is correct; the popup just won't have node names.
      nodesByDataId = null;
    }

    // Tolerant matcher: handles `var(--name)`, `var(--name, fallback)`, and
    // arbitrary leading whitespace inside the parens.
    const varRegex = /var\(\s*--([a-zA-Z0-9_-]+)/g;
    let match: RegExpExecArray | null;
    const seenInFile = new Set<string>(); // tokenName::nodeId dedupe
    while ((match = varRegex.exec(code)) !== null) {
      const tokenName = match[1];
      const nodeId = findEnclosingDataId(code, match.index) ?? '__file__';
      const dedupeKey = `${tokenName}::${nodeId}`;
      if (seenInFile.has(dedupeKey)) continue;
      seenInFile.add(dedupeKey);

      let arr = result.get(tokenName);
      if (!arr) { arr = []; result.set(tokenName, arr); }
      const nodeMeta = nodeId !== '__file__' ? nodesByDataId?.get(nodeId) : null;
      arr.push({
        filePath,
        fileLabel,
        nodeId,
        nodeName: nodeMeta?.name ?? fileLabel,
      });
    }
  }

  return result;
}

/** Map<tokenName, PresetUsage[]> — every node in the project that references
 *  a preset via `var(--name)` in any inline style value. Re-derives whenever
 *  `projectVersion` bumps (mutations, undo/redo, file swaps); jotai memoizes
 *  the result between bumps. Wraps the pure {@link scanPresetUsage} helper
 *  with `projectFS` access + a diagnostic trace. */
export const presetUsageAtom = atom<Map<string, PresetUsage[]>>((get) => {
  // Subscribe to version so usage updates when any file changes.
  get(projectVersionAtom);

  const files = new Map<string, string>();
  for (const path of projectFS.listFiles()) {
    const content = projectFS.readFile(path);
    if (content !== null) files.set(path, content);
  }

  const result = scanPresetUsage(files);

  trace.action('preset-usage:scan', {
    files: files.size,
    tokens: result.size,
    totalUsages: Array.from(result.values()).reduce((s, l) => s + l.length, 0),
    foundTokens: Array.from(result.keys()),
  });

  return result;
});

/** Walk backwards from `offset` to find the most recent `data-id="…"` that
 *  encloses this position. Heuristic — assumes a `data-id` on every JSX
 *  element (which Revyme enforces) and that a style attribute always
 *  follows its element's data-id. Used to attribute a `var(--token)` match
 *  to a specific node without traversing the full AST per match. */
export function findEnclosingDataId(code: string, offset: number): string | null {
  const before = code.slice(0, offset);
  // Match the LAST data-id="..." occurrence before this offset.
  const re = /data-id\s*=\s*"([^"]+)"/g;
  let last: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(before)) !== null) {
    last = m[1];
  }
  return last;
}

/** Friendly label for a file path used in the usage popup.
 *  - `app/page.client.tsx` → 'Home'
 *  - `app/about/page.client.tsx` → '/about'
 *  - `components/Hero.tsx` → 'Hero'
 *  Accepts either half of the page pair (server wrapper or client
 *  body) so call sites that still hold a legacy `page.tsx` path keep
 *  resolving to the right label.
 *  Falls back to the basename when the structure is unusual. */
export function deriveFileLabel(filePath: string): string {
  // Pages: strip `app/` + the `/page.(client.)tsx` suffix, then drop Next.js
  // ROUTE-GROUP segments — `(Body)`, `(marketing)`, … — which are ProjectFS
  // organizational metadata, NOT part of the URL. So `app/(Body)/advisors/
  // page.client.tsx` reads as `/advisors`, and the group index `app/(Body)/
  // page.client.tsx` reads as `Home`.
  const rest = filePath.startsWith('app/') ? filePath.slice('app/'.length) : null;
  if (rest !== null && /(^|\/)page\.(client\.)?tsx$/.test(rest)) {
    const inner = rest.replace(/\/?page\.(client\.)?tsx$/, '');
    const segs = inner.split('/').filter((s) => s && !/^\(.+\)$/.test(s));
    return segs.length === 0 ? 'Home' : '/' + segs.join('/');
  }
  if (filePath.startsWith('components/') && filePath.endsWith('.tsx')) {
    return filePath.slice('components/'.length, -'.tsx'.length);
  }
  return filePath;
}
