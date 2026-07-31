// preset-ops.ts — Operations for reading/writing presets from ProjectFS.
//
// All token data lives in `app/globals.css` in ProjectFS.
// This module provides the imperative API for CRUD on tokens.
// Parsing/serialization logic lives in preset-gen.ts — NO duplication here.

import { projectFS } from './project-fs';
import {
  parsePresetTokens,
  updatePresetTokenInCSS,
  addPresetTokenToCSS,
  removePresetTokenFromCSS,
} from '../generation/preset-gen';
import type { PresetToken } from '@/shared/types';
import { trace } from '@/shared/debug-trace';
import { parseVarRef } from '@/shared/css-utils';

const TOKENS_PATH = 'app/globals.css';

/**
 * Read and parse all preset tokens from ProjectFS.
 * Returns [] if the file doesn't exist yet.
 */
export function getPresetTokens(): PresetToken[] {
  trace.fn('preset-ops:getPresetTokens');
  const css = projectFS.readFile(TOKENS_PATH);
  if (!css) {
    trace.action('preset-ops:getPresetTokens:no-file');
    return [];
  }
  const tokens = parsePresetTokens(css);
  trace.action('preset-ops:getPresetTokens:done', { tokenCount: tokens.length });
  return tokens;
}

/**
 * Update a single token's value and write back to ProjectFS.
 */
export function updatePresetToken(name: string, value: string): void {
  trace.fn('preset-ops:updatePresetToken', { name, value });
  const css = projectFS.readFile(TOKENS_PATH);
  if (!css) {
    trace.error('preset-ops:updatePresetToken', 'tokens.css not found');
    return;
  }
  const updated = updatePresetTokenInCSS(css, name, value);
  projectFS.writeFile(TOKENS_PATH, updated);
  trace.action('preset-ops:updatePresetToken:done', { name });
}

/**
 * Add a new token and write back to ProjectFS.
 */
export function addPresetToken(token: PresetToken): void {
  trace.fn('preset-ops:addPresetToken', { name: token.name, category: token.category });
  const css = projectFS.readFile(TOKENS_PATH) ?? '';
  const updated = addPresetTokenToCSS(css, token);
  projectFS.writeFile(TOKENS_PATH, updated);
  trace.action('preset-ops:addPresetToken:done', { name: token.name });
}

/**
 * Remove a token by name and write back to ProjectFS.
 */
export function removePresetToken(name: string): void {
  trace.fn('preset-ops:removePresetToken', { name });
  const css = projectFS.readFile(TOKENS_PATH);
  if (!css) {
    trace.error('preset-ops:removePresetToken', 'tokens.css not found');
    return;
  }
  const updated = removePresetTokenFromCSS(css, name);
  projectFS.writeFile(TOKENS_PATH, updated);
  trace.action('preset-ops:removePresetToken:done', { name });
}

// Dark theme tokens live in `:root.dark { ... }` so they match the class
// next-themes adds to <html> (the default `attribute="class"` config in
// providers.tsx → <html class="dark">). The previous `[data-theme="dark"]`
// selector did not match, so toggling theme had no visible effect on
// preset-driven tokens. Older projects may still have an orphan
// `[data-theme="dark"]` block — `migrateLegacyDarkBlock` folds its
// contents into `:root.dark` on next write so values aren't lost.
const DARK_BLOCK_REGEX = /(:root\.dark\s*\{)([\s\S]*?)(\})/;
const LEGACY_DARK_REGEX = /\[data-theme="dark"\]\s*\{([\s\S]*?)\}\s*/;

export function migrateLegacyDarkBlock(css: string): string {
  const legacy = css.match(LEGACY_DARK_REGEX);
  if (!legacy) return css;
  const legacyBody = legacy[1].trim();
  const cleaned = css.replace(LEGACY_DARK_REGEX, '');
  if (!legacyBody) return cleaned;
  const existing = cleaned.match(DARK_BLOCK_REGEX);
  if (existing) {
    const merged = existing[2].trimEnd() + '\n  ' + legacyBody + '\n';
    return cleaned.replace(DARK_BLOCK_REGEX, `$1${merged}$3`);
  }
  return cleaned + `\n\n:root.dark {\n  ${legacyBody}\n}\n`;
}

/**
 * Read dark theme value for a token from tokens.css.
 * Returns null if no dark block or token not found. Falls back to the
 * legacy `[data-theme="dark"]` block if `:root.dark` doesn't have it yet.
 */
export function getDarkTokenValue(tokenName: string): string | null {
  const css = projectFS.readFile(TOKENS_PATH) || '';
  const propRegex = new RegExp(`--${tokenName}:\\s*([^;]+);`);
  const darkMatch = css.match(DARK_BLOCK_REGEX);
  if (darkMatch) {
    const m = darkMatch[2].match(propRegex);
    if (m) return m[1].trim();
  }
  const legacyMatch = css.match(LEGACY_DARK_REGEX);
  if (legacyMatch) {
    const m = legacyMatch[1].match(propRegex);
    if (m) return m[1].trim();
  }
  return null;
}

/**
 * Write dark theme value for a token to tokens.css under `:root.dark`.
 * Creates the block if missing and migrates any legacy
 * `[data-theme="dark"]` entries on the way.
 */
export function setDarkTokenValue(tokenName: string, darkValue: string): void {
  let css = projectFS.readFile(TOKENS_PATH) || '';
  css = migrateLegacyDarkBlock(css);
  const darkMatch = css.match(DARK_BLOCK_REGEX);
  if (darkMatch) {
    let body = darkMatch[2];
    const propRegex = new RegExp(`(--${tokenName}:\\s*)([^;]+)(;)`);
    if (propRegex.test(body)) body = body.replace(propRegex, `$1${darkValue}$3`);
    else body += `\n  --${tokenName}: ${darkValue};`;
    css = css.replace(DARK_BLOCK_REGEX, `$1${body}$3`);
  } else {
    css += `\n\n:root.dark {\n  --${tokenName}: ${darkValue};\n}\n`;
  }
  projectFS.writeFile(TOKENS_PATH, css);
  trace.action('preset-ops:set-dark-token', { tokenName, darkValue });
}

// ─── Google Font Import Injection ────────────────────────────────────────────

const SYSTEM_FONTS = [
  'arial', 'helvetica', 'times new roman', 'georgia', 'verdana',
  'courier new', 'tahoma', 'trebuchet ms', 'comic sans ms', 'impact',
  'sans-serif', 'serif', 'monospace', 'cursive', 'fantasy',
  'system-ui', '-apple-system', 'blinkmacsystemfont', 'segoe ui', 'inter',
];

/**
 * Ensure a Google Font @import exists in globals.css.
 * Extracts the font family name, skips system fonts, adds @import if missing.
 * Resolves the font on preview/live AND on canvas — the Renderer extracts
 * @import lines from globals.css and prepends them to the canvas stylesheet
 * (Renderer.ts tokensCSS extraction), so the iframe loads the face from here.
 */
export function ensureGoogleFontImport(fontFamilyValue: string): void {
  // Extract the primary font name: "'Cormorant Garamond', serif" → "Cormorant Garamond"
  const name = fontFamilyValue.split(',')[0].trim().replace(/['"]/g, '');
  if (!name) return;

  // Skip system fonts
  if (SYSTEM_FONTS.some(sf => name.toLowerCase().includes(sf))) return;

  const css = projectFS.readFile(TOKENS_PATH);
  if (!css) return;

  // Check if @import for this font already exists
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const importRegex = new RegExp(`@import\\s+url\\([^)]*${escapedName.replace(/ /g, '\\+')}[^)]*\\)`);
  if (importRegex.test(css)) return; // Already imported

  // Build import URL
  const urlFamily = `family=${name.replace(/ /g, '+')}:wght@300;400;500;600;700`;
  const importLine = `@import url('https://fonts.googleapis.com/css2?${urlFamily}&display=swap');`;

  // CSS requires @import before ALL other rules.
  // 1. Extract all existing @import lines from anywhere in the file
  // 2. Remove them from their current positions
  // 3. Prepend all imports (existing + new) at the very top
  const existingImportLines: string[] = [];
  const cssWithoutImports = css.replace(/@import\s+url\([^)]*\)[^;]*;\s*\n?/g, (match) => {
    existingImportLines.push(match.trim());
    return '';
  });

  // Add the new import if not already present
  if (!existingImportLines.some(line => line.includes(name.replace(/ /g, '+')))) {
    existingImportLines.push(importLine);
  }

  const updated = existingImportLines.join('\n') + '\n' + cssWithoutImports;
  projectFS.writeFile(TOKENS_PATH, updated);
  trace.action('preset-ops:ensureGoogleFontImport', { name, totalImports: existingImportLines.length });
}

/** A workspace custom font to declare in globals.css. */
export interface WorkspaceFontFaceSpec {
  family: string;
  /** Public (R2/CDN) url of the font file. */
  url: string;
  weight: number;
  style: 'normal' | 'italic';
  ext: 'woff2' | 'woff' | 'otf' | 'ttf';
}

/** `@font-face src` `format()` hint per container. */
function fontFaceFormat(ext: WorkspaceFontFaceSpec['ext']): string {
  return ext === 'woff2' ? 'woff2' : ext === 'woff' ? 'woff' : ext === 'otf' ? 'opentype' : 'truetype';
}

/**
 * Append `@font-face` rules for workspace custom fonts to globals.css, skipping
 * any whose src url is already declared (idempotent). Pure function — pass the
 * current css, get the next css. Rules are appended at the END so they never
 * precede the `@import` block (CSS requires `@import` first). The src points at
 * the hosted (R2) font file — same model as image assets — so the canvas
 * resolves it (via the Renderer's @font-face extraction) and a published site
 * loads it from the CDN.
 */
export function addWorkspaceFontFacesToCss(css: string, fonts: WorkspaceFontFaceSpec[]): string {
  const additions: string[] = [];
  for (const f of fonts) {
    if (css.includes(f.url)) continue; // already declared
    additions.push(
      `@font-face {\n` +
        `  font-family: '${f.family.replace(/'/g, "\\'")}';\n` +
        `  src: url('${f.url}') format('${fontFaceFormat(f.ext)}');\n` +
        `  font-weight: ${f.weight};\n` +
        `  font-style: ${f.style};\n` +
        `  font-display: swap;\n` +
        `}`,
    );
  }
  if (additions.length === 0) return css;
  const header = css.includes('/* Workspace custom fonts */') ? '' : '\n/* Workspace custom fonts */\n';
  return `${css.replace(/\s*$/, '')}\n${header}${additions.join('\n')}\n`;
}

/**
 * Resolve a var(--name) reference to its token value.
 * Returns null if not found.
 */
export function resolveTokenValue(varRef: string, tokens: PresetToken[]): string | null {
  let name = varRef;
  const varName = parseVarRef(varRef);
  if (varName) name = varName;
  else if (name.startsWith('--')) name = name.slice(2);

  const token = tokens.find(t => t.name === name);
  return token?.value ?? null;
}

/**
 * Resolve EVERY `var(--name)` reference inside a CSS value string to its token
 * value. Used to render preview swatches in the EDITOR frame: the project's
 * design tokens are defined only inside the canvas iframe, so an unresolved
 * `var(--color-x)` is invalid in the editor's CSS scope — and a single invalid
 * color stop makes the WHOLE declaration invalid (e.g. a gradient swatch
 * renders empty). Unknown tokens are left untouched (graceful no-op).
 */
export function resolveCssTokens(css: string, tokens: PresetToken[]): string {
  if (!css || !css.includes('var(')) return css;
  return css.replace(/var\(\s*--([^)\s,]+)\s*\)/g, (whole, name) => {
    const token = tokens.find(t => t.name === name);
    return token ? token.value : whole;
  });
}
