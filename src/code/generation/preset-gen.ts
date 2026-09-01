// preset-gen.ts — Parse/serialize :root { } CSS custom properties (design tokens).
//
// Reads/writes `app/globals.css` in ProjectFS.
// Each line `--name: value;` maps to a PresetToken.
//
// Category detection:
//   1. Name prefix:  --color-* → color, --typo-* → typography, etc.
//   2. Comment hint:  /* Category: color */ before a group
//   3. Value heuristic: #xxx / rgb( → color, small px → spacing, etc.

import { trace } from '@/shared/debug-trace';
import type { PresetToken } from '@/shared/types';

// ─── Category Detection ─────────────────────────────────────────────────────

type TokenCategory = PresetToken['category'];

const PREFIX_MAP: [string, TokenCategory][] = [
  ['color-', 'color'],
  ['typo-', 'typography'],
  ['space-', 'spacing'],
  ['margin-', 'margin'],
  ['radius-', 'radius'],
  ['shadow-', 'shadow'],
  ['border-', 'border'],
  ['image-', 'image'],
  ['video-', 'video'],
];

/** Detect category from the variable name prefix (without --). */
function categoryFromName(name: string): TokenCategory | null {
  for (const [prefix, cat] of PREFIX_MAP) {
    if (name.startsWith(prefix)) return cat;
  }
  return null;
}

/** Detect category from the value heuristic. */
function categoryFromValue(value: string): TokenCategory | null {
  const v = value.trim();
  // url() — image or video. We can't tell the two apart from the value alone
  // (an .mp4 in url() is still a CSS url), so leave that disambiguation to the
  // name prefix; if neither prefix nor heuristic identifies it, fall through to 'image'.
  if (/^url\s*\(/i.test(v)) return 'image';
  // Color: hex, rgb, rgba, hsl, hsla, named colors
  if (/^#[0-9a-fA-F]{3,8}$/.test(v)) return 'color';
  if (/^(?:rgb|rgba|hsl|hsla)\s*\(/.test(v)) return 'color';
  // Shadow: box-shadow-like pattern (number px number px ...)
  if (/^\d+.*\d+.*rgba?\(/.test(v)) return 'shadow';
  // Numeric px values — distinguish spacing/radius from typography
  const pxMatch = v.match(/^(-?[\d.]+)px$/);
  if (pxMatch) {
    const num = Math.abs(parseFloat(pxMatch[1]));
    if (num <= 24) return 'radius';
    if (num <= 120) return 'spacing';
    return 'typography'; // large values like heading sizes
  }
  return null;
}

/** Determine category for a token using name prefix first, then value heuristic. */
function detectCategory(name: string, value: string): TokenCategory {
  return categoryFromName(name) ?? categoryFromValue(value) ?? 'other';
}

// ─── Category Sort Order ────────────────────────────────────────────────────

const CATEGORY_ORDER: TokenCategory[] = ['color', 'typography', 'spacing', 'margin', 'radius', 'shadow', 'border', 'image', 'video', 'other'];

function categoryIndex(cat: TokenCategory): number {
  const idx = CATEGORY_ORDER.indexOf(cat);
  return idx === -1 ? CATEGORY_ORDER.length : idx;
}

// ─── Category Display Labels ────────────────────────────────────────────────

const CATEGORY_LABELS: Record<TokenCategory, string> = {
  color: 'Colors',
  typography: 'Typography',
  spacing: 'Spacing',
  margin: 'Margin',
  radius: 'Radius',
  shadow: 'Shadows',
  border: 'Borders',
  image: 'Images',
  video: 'Videos',
  other: 'Other',
};

// ─── Parse ──────────────────────────────────────────────────────────────────

/**
 * Parse :root { } block from CSS to extract preset tokens.
 * Input: CSS string from app/globals.css
 * Output: PresetToken[]
 */
export function parsePresetTokens(css: string): PresetToken[] {
  trace.fn('preset-gen:parsePresetTokens', { cssLength: css.length });

  // Find :root { ... } block
  const rootMatch = css.match(/:root\s*\{([\s\S]*?)\}/);
  if (!rootMatch) {
    trace.action('preset-gen:parsePresetTokens:no-root-block');
    return [];
  }

  const body = rootMatch[1];
  const tokens: PresetToken[] = [];

  // Track current comment-based category hint
  let commentCategory: TokenCategory | null = null;

  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();

    // Check for category comment: /* Category: color */ or /* Colors */
    const commentMatch = line.match(/^\/\*\s*(?:Category:\s*)?(\w+)\s*\*\/$/i);
    if (commentMatch) {
      const hint = commentMatch[1].toLowerCase();
      // Map comment text to category
      if (hint === 'colors' || hint === 'color') commentCategory = 'color';
      else if (hint === 'typography') commentCategory = 'typography';
      else if (hint === 'spacing') commentCategory = 'spacing';
      else if (hint === 'margin' || hint === 'margins') commentCategory = 'margin';
      else if (hint === 'border' || hint === 'borders') commentCategory = 'border';
      else if (hint === 'radius') commentCategory = 'radius';
      else if (hint === 'shadows' || hint === 'shadow') commentCategory = 'shadow';
      else if (hint === 'images' || hint === 'image') commentCategory = 'image';
      else if (hint === 'videos' || hint === 'video') commentCategory = 'video';
      else commentCategory = null;
      continue;
    }

    // Parse variable declaration: --name: value;
    const varMatch = line.match(/^--([a-zA-Z0-9_-]+)\s*:\s*(.*?)\s*;$/);
    if (!varMatch) continue;

    const name = varMatch[1];
    const value = varMatch[2];
    const category = commentCategory ?? detectCategory(name, value);

    tokens.push({ name, value, category });
  }

  trace.action('preset-gen:parsePresetTokens:done', { tokenCount: tokens.length });
  return tokens;
}

// ─── Serialize ──────────────────────────────────────────────────────────────

/**
 * Serialize preset tokens back to CSS :root block.
 * Groups tokens by category with comment headers.
 * Input: PresetToken[]
 * Output: full CSS string for app/globals.css
 */
export function serializePresetTokens(tokens: PresetToken[]): string {
  trace.fn('preset-gen:serializePresetTokens', { tokenCount: tokens.length });

  if (tokens.length === 0) {
    return '/* Design Tokens — Presets */\n:root {\n}\n';
  }

  // Group by category
  const groups = new Map<TokenCategory, PresetToken[]>();
  for (const token of tokens) {
    const list = groups.get(token.category) ?? [];
    list.push(token);
    groups.set(token.category, list);
  }

  let css = '/* Design Tokens — Presets */\n:root {\n';

  // Output groups in canonical order
  let first = true;
  for (const cat of CATEGORY_ORDER) {
    const group = groups.get(cat);
    if (!group || group.length === 0) continue;

    if (!first) css += '\n';
    first = false;

    css += `  /* ${CATEGORY_LABELS[cat]} */\n`;
    for (const token of group) {
      css += `  --${token.name}: ${token.value};\n`;
    }
  }

  css += '}\n';
  return css;
}

// ─── Update ─────────────────────────────────────────────────────────────────

/**
 * Update a single preset token value in CSS.
 * Input: current CSS, token name (without --), new value
 * Output: updated CSS
 */
export function updatePresetTokenInCSS(css: string, name: string, value: string): string {
  trace.fn('preset-gen:updatePresetTokenInCSS', { name, value });

  // Match --name: <old-value>;  and replace the value
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`(--${escaped}\\s*:\\s*)([^;]*)(;)`);
  const match = css.match(regex);

  if (!match) {
    trace.error('preset-gen:updatePresetTokenInCSS', `Token --${name} not found in CSS`);
    return css;
  }

  return css.replace(regex, `$1${value}$3`);
}

// ─── Add ────────────────────────────────────────────────────────────────────

/**
 * Add a new preset token to CSS.
 * Inserts into the correct category group, or creates one.
 */
export function addPresetTokenToCSS(css: string, token: PresetToken): string {
  trace.fn('preset-gen:addPresetTokenToCSS', { name: token.name, category: token.category });

  // If token already exists, update it instead of duplicating
  const escaped = token.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`--${escaped}\\s*:`).test(css)) {
    trace.action('preset-gen:addPresetTokenToCSS:exists-updating', { name: token.name });
    return updatePresetTokenInCSS(css, token.name, token.value);
  }

  const line = `  --${token.name}: ${token.value};`;
  const commentLabel = CATEGORY_LABELS[token.category];

  // Check if :root block exists
  const rootMatch = css.match(/:root\s*\{([\s\S]*?)\}/);
  if (!rootMatch) {
    // No :root block — APPEND one, never replace the file. globals.css also
    // carries the seed reset and Google-font @imports; returning only the
    // serialized tokens here erased both on the first preset write to a
    // project whose globals had no :root yet (live find 2026-08-31: reset +
    // imports wiped → published layout blowouts + fallback fonts).
    trace.action('preset-gen:addPresetTokenToCSS:creating-root-block');
    const block = serializePresetTokens([token]);
    return css.trim().length > 0 ? `${css.replace(/\s+$/, '')}\n\n${block}` : block;
  }

  const body = rootMatch[1];

  // Find the category comment in the body
  const commentPattern = new RegExp(`(\\/\\*\\s*${commentLabel}\\s*\\*\\/)`, 'i');
  const commentMatch = body.match(commentPattern);

  if (commentMatch) {
    // Category group exists — find the last variable in this group and insert after it
    const commentIdx = body.indexOf(commentMatch[0]);
    const afterComment = body.slice(commentIdx + commentMatch[0].length);

    // Find the last --var: value; line before the next comment or end of block
    const linesAfter = afterComment.split('\n');
    let lastVarLineIdx = -1;
    const offset = commentIdx + commentMatch[0].length;

    for (let i = 0; i < linesAfter.length; i++) {
      const l = linesAfter[i].trim();
      if (l.startsWith('--')) {
        lastVarLineIdx = i;
      } else if (l.startsWith('/*') && i > 0) {
        // Next group starts
        break;
      }
    }

    if (lastVarLineIdx >= 0) {
      // Insert after the last variable in this group
      let insertOffset = offset;
      for (let i = 0; i <= lastVarLineIdx; i++) {
        insertOffset += linesAfter[i].length + 1; // +1 for \n
      }
      const newBody = body.slice(0, insertOffset) + line + '\n' + body.slice(insertOffset);
      return css.replace(rootMatch[1], newBody);
    } else {
      // Comment exists but no variables after it — insert right after comment
      const insertOffset = commentIdx + commentMatch[0].length;
      const newBody = body.slice(0, insertOffset) + '\n' + line + body.slice(insertOffset);
      return css.replace(rootMatch[1], newBody);
    }
  } else {
    // No category group — parse all, add token, re-serialize for clean output
    const tokens = parsePresetTokens(css);
    tokens.push(token);
    return serializePresetTokens(tokens);
  }
}

// ─── Remove ─────────────────────────────────────────────────────────────────

/**
 * Remove a preset token from CSS.
 */
export function removePresetTokenFromCSS(css: string, name: string): string {
  trace.fn('preset-gen:removePresetTokenFromCSS', { name });

  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Remove the full line including leading whitespace and trailing newline
  const regex = new RegExp(`^[ \t]*--${escaped}\\s*:[^;]*;[ \t]*\n?`, 'm');
  const match = css.match(regex);

  if (!match) {
    trace.error('preset-gen:removePresetTokenFromCSS', `Token --${name} not found in CSS`);
    return css;
  }

  const result = css.replace(regex, '');

  // Clean up: remove empty category comments (comment followed by blank line or another comment/closing brace)
  return result.replace(/^[ \t]*\/\*[^*]*\*\/[ \t]*\n(?=[ \t]*(?:\/\*|\}))/gm, '');
}
