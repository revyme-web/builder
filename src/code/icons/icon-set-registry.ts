// icon-set-registry.ts — Discover and cache icon-set files from ProjectFS.
//
// Scans the icons/ directory for .tsx files carrying the `@iconSet`
// annotation, parses each into an `IconSetInfo` (display name + ordered
// list of icons in the set), and caches by content hash so repeat
// scans are cheap.
//
// What's parsed out of each file:
//   - displayName  — from `/** @name "..." */`
//   - exportName   — the default-export tag (PascalCase, by convention
//                    matches the file basename)
//   - icons[]      — every `<svg data-id="..." data-name="...">` direct
//                    child of the `<div data-id="iconset-master">`. The
//                    new file template (post-2026-05-04) inlines all
//                    icons into a single master JSX tree as the source
//                    of truth, so we read them directly from there.
//
// Why not regex everything: the master `<div>` has a stable, simple
// shape because it's only ever produced by the template builder, so a
// tight regex pass is correct in practice and orders of magnitude
// cheaper than running the babel parser per file.

import type { ProjectFS } from '../project/project-fs';
import { simpleHash } from '@/shared/hash-utils';
import { isIconSetCode, parseIconSetDisplayName } from './icon-set-template';
import { parseIconSetConfig } from './icon-set-config';
import { trace } from '@/shared/debug-trace';

// ─── Types ────────────────────────────────────────────────────────────────

export interface IconEntryInfo {
  /** The `data-id` on the icon's `<svg>` element. e.g. 'icon-1'. */
  id: string;
  /** Layers-panel label, from the SVG's `data-name` attribute. */
  displayName: string;
  /** The icon's SVG markup as a serialized string, ready for
   *  dangerouslySetInnerHTML on a thumbnail. JSX-only attrs
   *  (`style={style}`, `data-id`, `data-name`) are stripped so it
   *  renders cleanly outside the React tree. */
  svgMarkup: string;
  /** viewBox attribute parsed from the icon's <svg>, used to size
   *  thumbnails proportionally. Falls back to '0 0 100 100' if absent. */
  viewBox: string;
  /** Intrinsic vector dimensions from iconConfig. Picker thumbnails use
   *  these as the EFFECTIVE viewBox so the full painted area (including
   *  group children that extend past the inner SVG's own viewBox) fits
   *  inside the tile — without this, thumbnails show only the top-left
   *  patch of grouped icons whose content extends beyond the inner SVG. */
  width: number;
  height: number;
  /** The variant card's `backgroundColor` (so the thumbnail matches the canvas
   *  card, not the picker's dark tile). Undefined for legacy bare-svg entries. */
  bgColor?: string;
}

export interface IconSetInfo {
  /** The default-export tag name — e.g. 'Naxoba'. */
  exportName: string;
  /** Path of the file in ProjectFS, e.g. 'icons/Naxoba.tsx'. */
  filePath: string;
  /** User-given set name from `@name`, falls back to exportName. */
  displayName: string;
  /** Icons in declaration order. */
  icons: IconEntryInfo[];
  /** Content hash for cache invalidation. */
  contentHash: string;
}

// ─── Registry ─────────────────────────────────────────────────────────────

const cache = new Map<string, { hash: string; info: IconSetInfo }>();

/**
 * Build the icon-set registry from `icons/` files. Returns a Map keyed
 * by exportName for O(1) lookup from JSX tags. Cached by content hash —
 * unchanged files re-use their parse result.
 */
export function buildIconSetRegistry(fs: ProjectFS): Map<string, IconSetInfo> {
  const registry = new Map<string, IconSetInfo>();

  const files = fs.listFiles('icons/').filter(f => f.endsWith('.tsx'));

  for (const filePath of files) {
    const code = fs.readFile(filePath);
    if (!code) continue;
    if (!isIconSetCode(code)) continue;

    const hash = simpleHash(code);
    const cached = cache.get(filePath);
    if (cached && cached.hash === hash) {
      registry.set(cached.info.exportName, cached.info);
      continue;
    }

    const info = parseIconSetFile(filePath, code, hash);
    if (info) {
      registry.set(info.exportName, info);
      cache.set(filePath, { hash, info });
    }
  }

  trace.fn('buildIconSetRegistry', { count: registry.size, files: files.length });
  return registry;
}

/** Reset the registry cache (called on file mutations). */
export function clearIconSetCache(): void {
  cache.clear();
}

// ─── Parser ───────────────────────────────────────────────────────────────

/** Extract `IconSetInfo` from a single icon-set file. Exported so CDN
 *  vector URLs can be parsed too — IconSetTool fetches the bundle's
 *  TSX source via `useCdnSource(url)` and feeds it here with
 *  `filePath = <https URL>` so the rest of the tool's flow keys off
 *  the URL the same way local file paths do. */
export function parseIconSetFile(filePath: string, code: string, hash: string): IconSetInfo | null {
  const fileBase = filePath.split('/').pop()?.replace(/\.tsx$/, '') ?? '';

  // Default export tag — try `export default function Name(` first, then
  // bare `export default Name;`. Mirrors component-registry's logic but
  // simpler because the icon-set template always uses `export default function`.
  let exportName = fileBase;
  const fnExportMatch = code.match(/export\s+default\s+function\s+(\w+)\s*\(/);
  if (fnExportMatch) {
    exportName = fnExportMatch[1];
  } else {
    const bareExportMatch = code.match(/export\s+default\s+(\w+)\s*;?\s*$/m);
    if (bareExportMatch) exportName = bareExportMatch[1];
  }

  const displayName = parseIconSetDisplayName(code) || exportName;
  const icons = parseIconsMap(code);

  if (icons.length === 0) {
    trace.error('icon-set-registry:no-icons', { filePath });
    // Still register the set — empty sets are valid (user could be in the
    // middle of clearing icons). The picker will show 0 entries.
  }

  return { exportName, filePath, displayName, icons, contentHash: hash };
}

/**
 * Parse the master `<div data-id="iconset-master">`'s direct `<svg>`
 * children into ordered IconEntryInfo[]. The SVGs have stable shape
 * because the template builder is the only code path that produces
 * them — each carries a `data-id`, `data-name`, and a `style={{...}}`
 * with the master-grid positioning.
 */
function parseIconsMap(code: string): IconEntryInfo[] {
  const entries: IconEntryInfo[] = [];

  // Find the master view's body span via brace-walking <div>/</div>.
  // Try data-id="root" (current template) first, fall back to legacy
  // data-id="iconset-master" so existing files keep parsing.
  const rootIdx = code.indexOf('data-id="root"');
  const masterIdx = rootIdx !== -1 ? rootIdx : code.indexOf('data-id="iconset-master"');
  if (masterIdx === -1) return entries;
  const tagEndIdx = code.indexOf('>', masterIdx);
  if (tagEndIdx === -1) return entries;
  let depth = 1;
  let scan = tagEndIdx + 1;
  let masterEnd = code.length;
  while (scan < code.length && depth > 0) {
    const nextOpen = code.indexOf('<div', scan);
    const nextClose = code.indexOf('</div>', scan);
    if (nextClose === -1) break;
    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth++;
      scan = nextOpen + 4;
    } else {
      depth--;
      if (depth === 0) { masterEnd = nextClose; break; }
      scan = nextClose + 6;
    }
  }
  const body = code.slice(tagEndIdx + 1, masterEnd);

  // iconConfig is the source of truth for which ids are vectors AND for
  // their intrinsic display dimensions. Without this filter the regex
  // also matches the inner shape svgs (e.g.
  // `<svg data-id="shape-icon-1-default">`) and the picker would show
  // every shape inside every vector as a separate icon. Legacy files
  // without iconConfig fall back to "match any data-id" for backward
  // compat. The dimensions map (id → {width,height}) is consulted when
  // building each entry so picker thumbnails know the FULL painted area
  // they should fit (vs the inner SVG's smaller intrinsic viewBox).
  const iconConfigEntries = parseIconSetConfig(code);
  const validIconIds = new Set(iconConfigEntries.map(c => c.name));
  const iconDims = new Map<string, { width: number; height: number }>();
  for (const c of iconConfigEntries) iconDims.set(c.name, { width: c.width, height: c.height });

  // Walk each Vector entry. Current template wraps each icon in a
  // `<div data-id="icon-N">...</div>` (so the container behaves like
  // a frame, not an svg). Legacy template (pre-2026-05-04) used a bare
  // `<svg data-id="icon-N">...</svg>`. Match both — the regex captures
  // either tag name plus its data-id, then we brace-walk to the matching
  // close tag.
  const entryRe = /<(div|svg)\b([^>]*)\bdata-id="([^"]+)"([^>]*)>/g;
  let m: RegExpExecArray | null;
  while ((m = entryRe.exec(body)) !== null) {
    const tagName = m[1];
    const attrChunkBefore = m[2];
    const id = m[3];
    const attrChunkAfter = m[4];
    // Skip non-vector ids (inner shape svgs etc) when iconConfig exists.
    if (validIconIds.size > 0 && !validIconIds.has(id)) continue;
    const fullAttrChunk = attrChunkBefore + ' ' + attrChunkAfter;
    const nameMatch = fullAttrChunk.match(/\bdata-name="([^"]+)"/);
    const displayName = nameMatch ? nameMatch[1] : id;

    // Find the matching close tag, brace-walking same-name open/close.
    const openTagPattern = `<${tagName}`;
    const closeTagPattern = `</${tagName}>`;
    let depth = 1;
    let scan = entryRe.lastIndex;
    let closeIdx = -1;
    while (scan < body.length && depth > 0) {
      const nextOpen = body.indexOf(openTagPattern, scan);
      const nextClose = body.indexOf(closeTagPattern, scan);
      if (nextClose === -1) break;
      if (nextOpen !== -1 && nextOpen < nextClose) {
        depth++;
        scan = nextOpen + openTagPattern.length;
      } else {
        depth--;
        if (depth === 0) { closeIdx = nextClose; break; }
        scan = nextClose + closeTagPattern.length;
      }
    }
    if (closeIdx === -1) continue;
    const fullEntry = body.slice(m.index, closeIdx + closeTagPattern.length);
    const { svgMarkup, viewBox, bgColor } = extractEntryThumb(fullEntry, tagName);
    const dims = iconDims.get(id) ?? { width: 100, height: 100 };
    entries.push({ id, displayName, svgMarkup, viewBox, width: dims.width, height: dims.height, bgColor });
  }

  return entries;
}

/** Extract thumbnail content from a Vector entry. For a DIV wrapper (modern
 *  vector variant) this returns the variant's FULL inner content converted to
 *  plain HTML (every shape with its CSS/x-y positioning intact) + the card's
 *  bgColor, so the picker thumbnail renders the variant PIXEL-PERFECT (the same
 *  way the canvas does) rather than cropping to the first shape. Legacy bare-svg
 *  entries keep the simple sanitize. */
function extractEntryThumb(entry: string, tagName: string): { svgMarkup: string; viewBox: string; bgColor?: string } {
  // Bare-svg legacy entries: just sanitize directly (no card background).
  if (tagName === 'svg') return sanitizeSvgForThumb(entry);
  // Div wrapper: render the FULL inner content as HTML.
  const divTagEnd = entry.indexOf('>');
  const divClose = entry.lastIndexOf('</div>');
  if (divTagEnd === -1 || divClose === -1) {
    return { svgMarkup: '', viewBox: '0 0 100 100', bgColor: '#ffffff' };
  }
  const bgMatch = entry.slice(0, divTagEnd).match(/backgroundColor:\s*['"]([^'"]+)['"]/);
  const bgColor = bgMatch ? bgMatch[1] : '#ffffff';
  const inner = entry.slice(divTagEnd + 1, divClose);
  const vbMatch = inner.match(/viewBox="([^"]+)"/);
  return { svgMarkup: jsxMarkupToHtml(inner), viewBox: vbMatch ? vbMatch[1] : '0 0 100 100', bgColor };
}

/** Convert a JSX markup fragment to plain HTML for dangerouslySetInnerHTML:
 *  `motion.svg` → `svg` (motion shapes aren't real DOM elements), JSX style
 *  objects → CSS strings (so CSS-positioned shapes stay positioned), and strip
 *  JSX-expression attrs (`layout={true}`, `data-id`, `data-name`). */
function jsxMarkupToHtml(jsx: string): string {
  return jsx
    .replace(/(<\/?)motion\.([a-zA-Z][\w]*)/g, '$1$2')
    .replace(/\s*data-id="[^"]*"/g, '')
    .replace(/\s*data-name="[^"]*"/g, '')
    .replace(/style=\{\{([^}]*)\}\}/g, (_m, body: string) => `style="${jsxStyleBodyToCss(body)}"`)
    .replace(/\s+[a-zA-Z][\w-]*=\{[^}]*\}/g, '');
}

/** `position: 'absolute', width: '63px', backgroundColor: '#fff'` →
 *  `position: absolute; width: 63px; background-color: #fff`. */
function jsxStyleBodyToCss(body: string): string {
  return body.split(',').map((pair) => {
    const idx = pair.indexOf(':');
    if (idx === -1) return '';
    const key = pair.slice(0, idx).trim().replace(/['"]/g, '');
    const val = pair.slice(idx + 1).trim().replace(/['"]/g, '');
    if (!key || !val) return '';
    return `${key.replace(/([A-Z])/g, '-$1').toLowerCase()}: ${val}`;
  }).filter(Boolean).join('; ');
}

/** Strip JSX-only attrs from an `<svg ...>...</svg>` block so its markup can
 *  be safely injected via dangerouslySetInnerHTML on a picker thumbnail. */
function sanitizeSvgForThumb(svg: string): { svgMarkup: string; viewBox: string } {
  let cleaned = svg;
  cleaned = cleaned.replace(/\s*style=\{\{[^}]*\}\}/g, '');
  cleaned = cleaned.replace(/\s*data-id="[^"]*"/g, '');
  cleaned = cleaned.replace(/\s*data-name="[^"]*"/g, '');
  const vbMatch = cleaned.match(/viewBox="([^"]+)"/);
  const viewBox = vbMatch ? vbMatch[1] : '0 0 100 100';
  return { svgMarkup: cleaned, viewBox };
}
