// plugins/sdk-impl/presets.ts — presets.* + styles.* namespaces.
//
// Both namespaces map onto the same Revyme primitive: design
// tokens declared in `app/tokens.css` (color values + composite text
// styles). `presets.*` is the Revyme-specific surface;
// `styles.*` is design-tool-parity API that proxies the same store.
// Plugin authors can use either; we don't pick a canonical name
// because both ecosystems will read this code.

import { getPresetTokens, addPresetToken, setDarkTokenValue } from '@/code/project/preset-ops';
import { getPresetFolderOps } from '@/code/project/preset-folder-ops';
import { bumpProjectVersion } from '@/code/project/modify-file';
import type { PresetToken } from '@/shared/types';
import type { ColorStyle, TextStyle } from '@revyme/plugin-sdk';
import type { RpcHandler } from '../plugin-types';

/**
 * Place a token in a folder for the given category — creating the
 * folder if it doesn't already exist with that name. Used by the
 * `addColorToken` / `addTextToken` `opts.folderName` shortcut so
 * plugins can add a token AND group it in one call.
 *
 * Idempotent on folder creation: if a folder with this name already
 * exists, we reuse its id rather than create a duplicate. Folder
 * names are case-sensitive (matches the editor's right-panel UI).
 */
function placeTokenInFolder(category: string, tokenName: string, folderName: string): void {
  const ops = getPresetFolderOps(category);
  const existing = ops.listFolders().find((f) => f.name === folderName);
  const folderId = existing ? existing.id : ops.createFolder(folderName);
  ops.moveItemToFolder(tokenName, folderId);
}

/** Map a public token category string to the folder-ops category key. */
function categoryKeyFor(category: string): string {
  // The right-panel UI groups tokens by category — `color` for
  // colors, `typography` for text styles. The folder ops are keyed
  // by the SAME strings the UI uses, so plugin authors can pass them
  // verbatim without translation.
  return category;
}

function presetTokenToColorStyle(t: PresetToken): ColorStyle | null {
  const v = t.value.trim();
  if (/^(#|rgb|hsl)/i.test(v)) return { id: t.name, name: t.name, value: v };
  return null;
}

function presetTokenToTextStyle(t: PresetToken): TextStyle | null {
  const n = t.name.toLowerCase();
  if (/(text|heading|h[1-6]|body|caption|title|label)$/.test(n)) {
    return { id: t.name, name: t.name, attributes: { value: t.value } };
  }
  return null;
}

export const presetsHandlers: Record<string, RpcHandler> = {
  // ─── presets.* (Revyme primary API) ────────────────────────────────
  'presets.listColorTokens': async (): Promise<ColorStyle[]> =>
    getPresetTokens().map(presetTokenToColorStyle).filter((x): x is ColorStyle => x !== null),

  'presets.listTextTokens': async (): Promise<TextStyle[]> =>
    getPresetTokens().map(presetTokenToTextStyle).filter((x): x is TextStyle => x !== null),

  'presets.addColorToken': async (params): Promise<void> => {
    const p = params as { name?: unknown; value?: unknown; opts?: { folderName?: string } };
    if (typeof p?.name !== 'string' || typeof p?.value !== 'string') {
      throw new Error('presets.addColorToken: name + value (strings) required');
    }
    addPresetToken({ name: p.name, value: p.value, category: 'color' });
    // Optional folder placement — create-or-reuse a folder with
    // `opts.folderName` and move the new token inside.
    if (p.opts?.folderName) {
      placeTokenInFolder(categoryKeyFor('color'), p.name, p.opts.folderName);
    }
    // `addPresetToken` writes to globals.css but doesn't bump the
    // project version atom — derived atoms (the Color section in the
    // right panel) never re-read without it. Bump explicitly so the
    // panel sees the new token immediately. Same applies for the
    // folder-ops writes above (they also hit projectFS directly).
    bumpProjectVersion();
  },

  'presets.addTextToken': async (params): Promise<void> => {
    const p = params as { name?: unknown; attrs?: unknown; opts?: { folderName?: string } };
    if (typeof p?.name !== 'string' || !p.attrs || typeof p.attrs !== 'object') {
      throw new Error('presets.addTextToken: name + attrs required');
    }
    const attrs = p.attrs as Record<string, string>;
    const value = attrs.value
      ?? Object.entries(attrs).map(([k, v]) => `${k}: ${v}`).join('; ');
    addPresetToken({ name: p.name, value, category: 'typography' });
    if (p.opts?.folderName) {
      placeTokenInFolder(categoryKeyFor('typography'), p.name, p.opts.folderName);
    }
    bumpProjectVersion();
  },

  'presets.createFolder': async (params): Promise<string> => {
    const p = params as { category?: unknown; name?: unknown };
    if (typeof p?.category !== 'string' || typeof p?.name !== 'string') {
      throw new Error('presets.createFolder: category + name (strings) required');
    }
    const ops = getPresetFolderOps(categoryKeyFor(p.category));
    const id = ops.createFolder(p.name);
    bumpProjectVersion();
    return id;
  },

  'presets.moveToFolder': async (params): Promise<void> => {
    const p = params as { category?: unknown; tokenName?: unknown; folderId?: unknown };
    if (typeof p?.category !== 'string' || typeof p?.tokenName !== 'string') {
      throw new Error('presets.moveToFolder: category + tokenName required');
    }
    const folderId = p.folderId === null ? null : (typeof p.folderId === 'string' ? p.folderId : null);
    const ops = getPresetFolderOps(categoryKeyFor(p.category));
    ops.moveItemToFolder(p.tokenName, folderId);
    bumpProjectVersion();
  },

  // ─── styles.* (design-tool-parity proxies) ──────────────────────────────────
  'styles.getColorStyles': async (): Promise<ColorStyle[]> =>
    getPresetTokens().map(presetTokenToColorStyle).filter((x): x is ColorStyle => x !== null),

  'styles.getTextStyles': async (): Promise<TextStyle[]> =>
    getPresetTokens().map(presetTokenToTextStyle).filter((x): x is TextStyle => x !== null),

  'styles.getColorStyle': async (params): Promise<ColorStyle | null> => {
    const p = params as { id?: unknown };
    if (typeof p?.id !== 'string') throw new Error('styles.getColorStyle: id required');
    const t = getPresetTokens().find((x) => x.name === p.id);
    return t ? presetTokenToColorStyle(t) : null;
  },

  'styles.getTextStyle': async (params): Promise<TextStyle | null> => {
    const p = params as { id?: unknown };
    if (typeof p?.id !== 'string') throw new Error('styles.getTextStyle: id required');
    const t = getPresetTokens().find((x) => x.name === p.id);
    return t ? presetTokenToTextStyle(t) : null;
  },

  'styles.createColorStyle': async (params): Promise<string> => {
    const p = params as { name?: unknown; value?: unknown; darkValue?: unknown };
    if (typeof p?.name !== 'string' || typeof p?.value !== 'string') {
      throw new Error('styles.createColorStyle: name + value required');
    }
    addPresetToken({ name: p.name, value: p.value, category: 'color' });
    // Optional NATIVE dark-mode variant: same token, second value written to
    // the `:root.dark { --name: … }` scope in tokens.css — exactly what the
    // editor's own sun/moon preset picker does. NOT a separate style.
    if (typeof p.darkValue === 'string' && p.darkValue) {
      setDarkTokenValue(p.name, p.darkValue);
    }
    bumpProjectVersion();
    return p.name;
  },

  'styles.createTextStyle': async (params): Promise<string> => {
    const p = params as { name?: unknown; attributes?: unknown };
    if (typeof p?.name !== 'string' || !p.attributes || typeof p.attributes !== 'object') {
      throw new Error('styles.createTextStyle: name + attributes required');
    }
    const attrs = p.attributes as Record<string, string>;
    const value = attrs.value
      ?? Object.entries(attrs).map(([k, v]) => `${k}: ${v}`).join('; ');
    addPresetToken({ name: p.name, value, category: 'typography' });
    bumpProjectVersion();
    return p.name;
  },
};
