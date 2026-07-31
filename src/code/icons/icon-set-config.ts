// icon-set-config.ts — Parse/serialize icon metadata from icon-set files.
//
// Mirrors `variant-config.ts` for icon sets: each entry holds the name,
// label, canvas position (x, y), and intrinsic dimensions (width, height)
// of one vector. Stored as `const iconConfig = [...]` at the top of the
// icon-set file (right above the function), same shape + same role as
// variantConfig in component master files.
//
// Why a config array (not inline styles on each <div>):
//   - Position is editor-only metadata. Pages that USE an icon-set
//     instance pass their own `style={{position, left, top, ...}}` —
//     so per-vector master-canvas positioning has no business riding
//     on the JSX. Lifting it to iconConfig keeps the master JSX clean
//     (vectors are pure content) and matches the variant pattern the
//     rest of the editor already understands.
//   - Drag updates write to iconConfig.x/y via updateIconPosition,
//     same way variant drags write to variantConfig.x/y. Same UX,
//     same code path.

import { trace } from '@/shared/debug-trace';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface IconConfig {
  /** Canonical id, matches the vector div's data-id. e.g. 'icon-1'. */
  name: string;
  /** Layers-panel label. Renameable, duplicates OK. */
  label: string;
  /** Canvas position on the icon-set master page. */
  x: number;
  y: number;
  /** Intrinsic dimensions used by the master canvas to size the
   *  vector container. Instances on pages override via their own style. */
  width: number;
  height: number;
  /** First entry = primary (source of truth for instance-default content). */
  isPrimary?: boolean;
}

// Layout defaults (match the existing icon-set-template constants so a
// freshly-created vector lands at the same grid position whether the
// caller passes explicit x/y or not).
export const ICON_DEFAULT_W = 240;
export const ICON_DEFAULT_H = 240;
export const ICON_DEFAULT_GAP = 40;

// ─── Default Config ─────────────────────────────────────────────────────────

export function createDefaultIconSetConfig(): IconConfig[] {
  return [{
    name: 'icon-1',
    label: 'Vector',
    x: 0,
    y: 0,
    width: ICON_DEFAULT_W,
    height: ICON_DEFAULT_H,
    isPrimary: true,
  }];
}

/**
 * Parse a drag/resize-committed CSS length into iconConfig px space.
 * ONLY plain px / unitless values are valid — a stray PERCENT anchor
 * parseFloat'd as px is exactly how mid-band cards jumped to x:49 on
 * mouse-up (`left: "48.6026%"` misread as 48.6px). Any non-px value
 * (or a missing one) keeps the entry's current value for that axis,
 * which also fixes the old `parseFloat('') || 0` axis-collapse.
 */
export function iconConfigPx(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const v = value.trim();
  const n = parseFloat(v);
  if (!Number.isFinite(n) || v.endsWith('%')) {
    trace.action('icon-set-config:non-px-position-rejected', { value: v, fallback });
    return fallback;
  }
  return n;
}

// ─── Parser ─────────────────────────────────────────────────────────────────

/**
 * Parse iconConfig from an icon-set file's source.
 * Mirrors `parseVariantConfig` — looks for `const iconConfig = [...]`
 * (not nested inside the function), normalizes JSON-ish syntax, returns
 * an empty array when missing so callers can decide whether to fall
 * back to defaults.
 */
export function parseIconSetConfig(code: string): IconConfig[] {
  const match = code.match(/const\s+iconConfig\s*=\s*(\[[\s\S]*?\]);/);
  if (!match) return [];

  try {
    const jsonStr = match[1]
      .replace(/'/g, '"')
      .replace(/(\w+)\s*:/g, '"$1":')
      .replace(/,\s*([}\]])/g, '$1');

    const parsed = JSON.parse(jsonStr) as Array<{
      name: string;
      label?: string;
      x?: number;
      y?: number;
      width?: number;
      height?: number;
      isPrimary?: boolean;
    }>;

    return parsed.map((v, i) => ({
      name: v.name,
      label: v.label ?? v.name,
      x: v.x ?? 0,
      y: v.y ?? 0,
      width: v.width ?? ICON_DEFAULT_W,
      height: v.height ?? ICON_DEFAULT_H,
      isPrimary: v.isPrimary ?? i === 0,
    }));
  } catch (e) {
    trace.error('icon-set-config:parse-failed', { error: String(e) });
    return [];
  }
}

// ─── Serializer ─────────────────────────────────────────────────────────────

/** Render an iconConfig array back into a `const iconConfig = [...]` block. */
export function serializeIconSetConfig(configs: IconConfig[]): string {
  const entries = configs.map(c => {
    const parts = [
      `name: '${c.name}'`,
      `label: '${c.label}'`,
      `x: ${Math.round(c.x)}`,
      `y: ${Math.round(c.y)}`,
      `width: ${Math.round(c.width)}`,
      `height: ${Math.round(c.height)}`,
    ];
    if (c.isPrimary) parts.push('isPrimary: true');
    return `  { ${parts.join(', ')} }`;
  });
  return `const iconConfig = [\n${entries.join(',\n')},\n];`;
}

// ─── Code mutation: update one entry's position ─────────────────────────────

/** Find/replace iconConfig in source code with the new array. Used by
 *  updateIconPosition / addIconToSet / removeIconFromSet so they share
 *  the same write contract. */
export function replaceIconSetConfigInCode(code: string, configs: IconConfig[]): string {
  const block = serializeIconSetConfig(configs);
  if (/const\s+iconConfig\s*=\s*\[/.test(code)) {
    return code.replace(/const\s+iconConfig\s*=\s*\[[\s\S]*?\];/, block);
  }
  // No iconConfig in source yet — inject right after the last import.
  const lastImport = code.lastIndexOf('\nimport ');
  if (lastImport !== -1) {
    const eol = code.indexOf('\n', lastImport + 1);
    if (eol !== -1) {
      return code.slice(0, eol + 1) + '\n' + block + '\n' + code.slice(eol + 1);
    }
  }
  // Worst case: stick it at the top.
  return block + '\n\n' + code;
}
