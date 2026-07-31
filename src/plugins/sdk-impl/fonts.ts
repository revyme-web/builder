// plugins/sdk-impl/fonts.ts — fonts.* namespace.
//
// Bundled common families until Revyme gets its own font picker.
// Each family ships normal + italic across 5 weights — enough
// granularity for plugin font pickers without exploding the list.
// When the host font picker lands, this widens to its full catalog.

import type { FontInfo } from '@revyme/plugin-sdk';
import type { RpcHandler } from '../plugin-types';

const FAMILIES = [
  'Inter', 'Roboto', 'Open Sans', 'Lato', 'Poppins', 'Montserrat',
  'Source Sans Pro', 'Nunito', 'Work Sans', 'IBM Plex Sans',
  'Helvetica', 'Arial', 'Times New Roman', 'Georgia', 'Courier New',
  'Menlo', 'ui-monospace',
];

const SYSTEM_FONTS: FontInfo[] = FAMILIES.flatMap((family): FontInfo[] => {
  const out: FontInfo[] = [];
  for (const weight of [300, 400, 500, 600, 700]) {
    for (const style of ['normal', 'italic'] as const) {
      out.push({ family, weight, style, hosted: false });
    }
  }
  return out;
});

export const fontsHandlers: Record<string, RpcHandler> = {
  'fonts.getFonts': async (): Promise<FontInfo[]> => SYSTEM_FONTS,

  'fonts.getFont': async (params): Promise<FontInfo | null> => {
    const p = params as { family?: unknown; opts?: { weight?: number; style?: 'normal' | 'italic' } };
    if (typeof p?.family !== 'string') throw new Error('fonts.getFont: family required');
    const family = p.family;
    const weight = p.opts?.weight ?? 400;
    const style = p.opts?.style ?? 'normal';
    return SYSTEM_FONTS.find(
      (f) => f.family.toLowerCase() === family.toLowerCase() && f.weight === weight && f.style === style,
    ) ?? null;
  },
};
