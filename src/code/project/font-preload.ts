// font-preload.ts — project-wide Google Font preloading.
//
// The old mount-time preload in Canvas.tsx scanned only the ACTIVE page's
// parsed node styles for `fontFamily`. Fonts referenced anywhere else never
// loaded until a UI side-effect happened to load them (opening the
// typography-preset editor mounts FontFamilyControl, which loadGoogleFont()s
// as it renders — that was the only reason preset fonts ever appeared):
//   • typography presets store the family in a `--typo-<name>-font` token in
//     app/globals.css and nodes carry `fontFamily: var(--typo-…-font)` —
//     a var() ref the node-style scan can't resolve to a family name,
//   • fonts used only on OTHER pages / components / LayoutClient never loaded,
//   • `font-family:` declarations inside <style> blocks never loaded.
//
// preloadProjectFonts() scans the WHOLE ProjectFS raw source plus the token
// map and loads every referenced family (font-loader dedupes re-calls). It
// also self-heals the matching Google Fonts @import in app/globals.css —
// the canvas iframe and the published site both resolve fonts through that
// @import, and preset flows that write tokens directly (AI generation, seeds)
// bypass FontFamilyControl's onChange, the only place that wrote it before.

import { projectFS } from './project-fs';
import { ensureGoogleFontImport } from './preset-ops';
import { isViewerMode } from '@/code/stores/viewer-mode-store';
import { loadGoogleFont } from '@/shared/font-loader';
import { trace } from '@/shared/debug-trace';

/** All custom-property declarations: `--name: value` (value up to `;` or `}`). */
const TOKEN_DECL_RE = /--([\w-]+)\s*:\s*([^;}]+)/g;
/** Token NAMES that hold a font-family list (`--typo-heading-font`,
 *  `--font-display`, `--brand-font-family`, …). */
const FONT_TOKEN_NAME_RE = /(?:^font-|-font(?:-family)?$)/;
/** Inline JSX style: `fontFamily: '…'` / `fontFamily: "…"`. Matched between
 *  the SAME quote character so nested quotes (`"'Space Grotesk', sans-serif"`)
 *  capture the full value — the family lands in group 2. */
const JSX_FONT_RE = /fontFamily:\s*(['"])(.*?)\1/g;
/** CSS declaration inside <style> blocks or .css files. Stops before
 *  `!important` and block/declaration delimiters. */
const CSS_FONT_RE = /font-family\s*:\s*([^;}{!]+)/g;

const SCANNABLE_EXT_RE = /\.(tsx|jsx|css)$/;
const CSS_WIDE_KEYWORDS = new Set(['inherit', 'initial', 'unset', 'revert', 'none']);

/** Resolve `var(--token)` / `var(--token, fallback)` chains against the
 *  project token map. Depth-capped so cyclic tokens can't loop forever. */
export function resolveVarRefs(value: string, tokens: Map<string, string>, depth = 0): string {
  if (depth > 4 || !value.includes('var(')) return value;
  const m = value.match(/var\(\s*--([\w-]+)\s*(?:,\s*([^)]+))?\)/);
  if (!m) return value;
  const replacement = tokens.get(m[1]) ?? m[2] ?? '';
  return resolveVarRefs(value.replace(m[0], replacement), tokens, depth + 1);
}

/** First family from a CSS font-family value, validated to look like a real
 *  family name ("Anton", "Cormorant Garamond"). Rejects unresolved var()
 *  leftovers, numbers ("16px"), and generic stacks ("sans-serif") so junk
 *  never reaches the Google Fonts CDN or the @import healer. */
export function extractFamilyName(cssValue: string): string | null {
  const fam = cssValue.split(',')[0].trim().replace(/['"]/g, '');
  if (!fam || CSS_WIDE_KEYWORDS.has(fam.toLowerCase())) return null;
  if (!/^[A-Za-z][A-Za-z0-9 ]*$/.test(fam)) return null;
  return fam;
}

/** Pure scanner — collect every font family referenced across the given
 *  sources (token declarations, inline JSX fontFamily, CSS font-family). */
export function collectFontFamilies(files: Record<string, string>): Set<string> {
  // Pass 1: token map from every .css file (presets live in app/globals.css).
  const tokens = new Map<string, string>();
  for (const [path, code] of Object.entries(files)) {
    if (!path.endsWith('.css')) continue;
    for (const m of code.matchAll(TOKEN_DECL_RE)) tokens.set(m[1], m[2].trim());
  }

  const families = new Set<string>();
  const add = (rawValue: string) => {
    const resolved = resolveVarRefs(rawValue.trim(), tokens);
    const fam = extractFamilyName(resolved);
    if (fam) families.add(fam);
  };

  // Pass 2: font tokens themselves + raw-source scan of every file. Raw
  // source (not the parsed NodeMap) so CSS rules, variant objects, and
  // non-active files all contribute — same approach as the preset-usage
  // scanner.
  for (const [name, value] of tokens) {
    if (FONT_TOKEN_NAME_RE.test(name)) add(value);
  }
  for (const [path, code] of Object.entries(files)) {
    if (!SCANNABLE_EXT_RE.test(path)) continue;
    for (const m of code.matchAll(JSX_FONT_RE)) add(m[2]);
    for (const m of code.matchAll(CSS_FONT_RE)) add(m[1]);
  }
  return families;
}

/** Load every Google Font the project references and make sure each has its
 *  @import in app/globals.css. Called on editor load and on page switch —
 *  cheap to re-run: loadGoogleFont dedupes by family, ensureGoogleFontImport
 *  no-ops once the import line exists (and skips system fonts itself). */
export function preloadProjectFonts(): void {
  const files: Record<string, string> = {};
  for (const path of projectFS.listFiles()) {
    if (!SCANNABLE_EXT_RE.test(path)) continue;
    const code = projectFS.readFile(path);
    if (code) files[path] = code;
  }
  const families = collectFontFamilies(files);
  const viewer = isViewerMode();
  for (const fam of families) {
    loadGoogleFont(fam);
    // Self-heal the @import for preview/live + the canvas iframe stylesheet.
    // Viewers must not mutate project files — their font load still works
    // through the parent/iframe <link> path above.
    if (!viewer) ensureGoogleFontImport(fam);
  }
  trace.action('font-preload:done', { familyCount: families.size, viewer });
}
