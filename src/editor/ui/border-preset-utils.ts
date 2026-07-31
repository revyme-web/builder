// border-preset-utils.ts — Compound border preset utilities. Mirrors the
// typography-utils.ts pattern: a single preset is a *group* of tokens that
// share a name prefix and apply together to multiple CSS properties.
//
// Two flavors share the same group name:
//   Solid:     border-{group}-width, -style, -color
//   Gradient:  border-{group}-width, -image-source, -image-slice
//
// Apply order matters: when a gradient preset is applied, borderColor is
// cleared and borderStyle is forced to 'solid' (the spec requires it for
// border-image to render). When a solid preset is applied, borderImage* keys
// are cleared so the gradient doesn't leak across.

import type { PresetToken } from '@/shared/types';
import { trace } from '@/shared/debug-trace';

// ─── Constants ───────────────────────────────────────────────────────────────

/** Token suffixes for a border group, longest first for greedy match. */
const BORDER_SUFFIXES = ['image-source', 'image-slice', 'width', 'style', 'color'] as const;
export type BorderSuffix = typeof BORDER_SUFFIXES[number];

// ─── Types ───────────────────────────────────────────────────────────────────

export interface BorderGroup {
  /** Group slug: `card`, `accent`, etc. */
  name: string;
  /** Display label: `Card`, `Accent`. */
  label: string;
  /** All tokens belonging to this group (subset of BORDER_SUFFIXES). */
  tokens: PresetToken[];
  /** Inferred flavor — present iff image-source token exists. */
  flavor: 'solid' | 'gradient';
}

// ─── Grouping ────────────────────────────────────────────────────────────────

/**
 * Group border tokens by their shared name prefix. A token like
 * `border-card-width` joins the `card` group. Tokens that don't end in a known
 * suffix fall back to using their full bare name as the group — which means
 * legacy single-value border tokens (from before compound mode) still surface
 * as their own one-token group.
 */
export function groupBorderTokens(tokens: PresetToken[]): BorderGroup[] {
  trace.fn('groupBorderTokens', { tokenCount: tokens.length });
  const groups = new Map<string, PresetToken[]>();

  for (const token of tokens) {
    if (token.category !== 'border') continue;
    const withoutPrefix = token.name.replace(/^border-/, '');

    let groupName = withoutPrefix;
    for (const suffix of BORDER_SUFFIXES) {
      if (withoutPrefix.endsWith('-' + suffix)) {
        groupName = withoutPrefix.slice(0, -(suffix.length + 1));
        break;
      }
    }
    if (!groupName) groupName = withoutPrefix;
    if (!groups.has(groupName)) groups.set(groupName, []);
    groups.get(groupName)!.push(token);
  }

  return Array.from(groups.entries()).map(([name, grpTokens]) => ({
    name,
    label: name.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
    tokens: grpTokens,
    flavor: grpTokens.some(t => t.name.endsWith('-image-source')) ? 'gradient' : 'solid',
  }));
}

// ─── Token-value helpers ─────────────────────────────────────────────────────

/** Get a single facet's value within a group; empty string if not present. */
export function getBorderTokenValue(group: BorderGroup, suffix: BorderSuffix): string {
  return group.tokens.find(t => t.name === `border-${group.name}-${suffix}`)?.value ?? '';
}

/** Get the var() reference for a facet — used when applying the preset. */
export function getBorderTokenVar(groupName: string, suffix: BorderSuffix): string {
  return `var(--border-${groupName}-${suffix})`;
}

// ─── Detection ───────────────────────────────────────────────────────────────

/**
 * Detect which border group is currently applied to a node. Looks at the
 * "anchor" property for each flavor — borderColor for solid, borderImageSource
 * for gradient — and back-derives the group name from `var(--border-{name}-...)`.
 * Returns null when no matching group is found.
 */
export function detectActiveBorderPreset(
  styles: Record<string, string>,
  groups: BorderGroup[],
): BorderGroup | null {
  const colorVar = styles.borderColor || styles.borderTopColor || '';
  const colorMatch = colorVar.match(/^var\(\s*--border-([a-z0-9-]+)-color\s*\)$/);
  if (colorMatch) {
    const found = groups.find(g => g.name === colorMatch[1] && g.flavor === 'solid');
    if (found) return found;
  }
  const imgVar = styles.borderImageSource || '';
  const imgMatch = imgVar.match(/^var\(\s*--border-([a-z0-9-]+)-image-source\s*\)$/);
  if (imgMatch) {
    const found = groups.find(g => g.name === imgMatch[1] && g.flavor === 'gradient');
    if (found) return found;
  }
  return null;
}

// ─── Apply / Clear ───────────────────────────────────────────────────────────

/**
 * Build the styles object that applies a border group. The caller passes this
 * to onChangeMultiple. Both flavors clear keys belonging to the *other* flavor
 * so swapping presets doesn't leak stale state (a gradient hanging on after
 * the user picks a solid preset, for example). Also clears the `border`
 * shorthand so longhands win.
 */
export function buildBorderApplyStyles(group: BorderGroup): Record<string, string> {
  const out: Record<string, string> = {
    // Always clear the global shorthand so longhand vars take over without conflict.
    border: '',
    // Per-side longhands — clear them so the uniform vars apply to all sides.
    borderTop: '', borderRight: '', borderBottom: '', borderLeft: '',
    borderTopWidth: '', borderTopStyle: '', borderTopColor: '',
    borderRightWidth: '', borderRightStyle: '', borderRightColor: '',
    borderBottomWidth: '', borderBottomStyle: '', borderBottomColor: '',
    borderLeftWidth: '', borderLeftStyle: '', borderLeftColor: '',
  };
  if (group.flavor === 'gradient') {
    out.borderWidth = getBorderTokenVar(group.name, 'width');
    // border-image only paints when border-style is non-none; force `solid`
    // (the actual style comes from the gradient's own pattern, this is a
    // CSS spec quirk — without it the border vanishes).
    out.borderStyle = 'solid';
    out.borderColor = '';
    out.borderImageSource = getBorderTokenVar(group.name, 'image-source');
    out.borderImageSlice = getBorderTokenVar(group.name, 'image-slice');
  } else {
    out.borderWidth = getBorderTokenVar(group.name, 'width');
    out.borderStyle = getBorderTokenVar(group.name, 'style');
    out.borderColor = getBorderTokenVar(group.name, 'color');
    // Strip any leftover gradient state from a prior preset.
    out.borderImageSource = '';
    out.borderImageSlice = '';
  }
  return out;
}

/** Build the styles object that removes any border preset application. */
export function buildBorderClearStyles(): Record<string, string> {
  return {
    border: '',
    borderWidth: '', borderStyle: '', borderColor: '',
    borderImageSource: '', borderImageSlice: '',
    borderTop: '', borderRight: '', borderBottom: '', borderLeft: '',
    borderTopWidth: '', borderTopStyle: '', borderTopColor: '',
    borderRightWidth: '', borderRightStyle: '', borderRightColor: '',
    borderBottomWidth: '', borderBottomStyle: '', borderBottomColor: '',
    borderLeftWidth: '', borderLeftStyle: '', borderLeftColor: '',
  };
}

// ─── Default token creation ──────────────────────────────────────────────────

/** Default 3-token solid border group for a fresh `Create border preset`. */
export function createDefaultSolidBorderTokens(slug: string): PresetToken[] {
  trace.action('createDefaultSolidBorderTokens', { slug });
  return [
    { name: `border-${slug}-width`, value: '1px', category: 'border' },
    { name: `border-${slug}-style`, value: 'solid', category: 'border' },
    { name: `border-${slug}-color`, value: '#000000', category: 'border' },
  ];
}

/** Default 3-token gradient border group. */
export function createDefaultGradientBorderTokens(slug: string): PresetToken[] {
  trace.action('createDefaultGradientBorderTokens', { slug });
  return [
    { name: `border-${slug}-width`, value: '2px', category: 'border' },
    { name: `border-${slug}-image-source`, value: 'linear-gradient(180deg, #6366f1 0%, #ec4899 100%)', category: 'border' },
    { name: `border-${slug}-image-slice`, value: '1', category: 'border' },
  ];
}
