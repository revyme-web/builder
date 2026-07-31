import type { ViewportConfig } from '@/shared/types';
import { trace } from '@/shared/debug-trace';

export interface CanvasConfig {
  viewports: ViewportConfig[];
  positions: Record<string, { x: number; y: number }>;
}

const CANVAS_BLOCK_REGEX = /\/\*\*\s*@canvas\s*(\{[\s\S]*?\})\s*\*\/\s*\n?/;

/** Parse /** @canvas { ... } *​/ from code string. Returns null if not found. */
export function parseCanvasConfig(code: string): CanvasConfig | null {
  const match = code.match(CANVAS_BLOCK_REGEX);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]);
    trace.fn('canvas-config:parse', { viewportCount: parsed.viewports?.length });
    return {
      viewports: parsed.viewports || [],
      positions: parsed.positions || {},
    };
  } catch {
    trace.error('canvas-config:parse-failed', { raw: match[1].slice(0, 100) });
    return null;
  }
}

/** Serialize a CanvasConfig to the comment block string. */
export function serializeCanvasConfig(config: CanvasConfig): string {
  const json = JSON.stringify({
    viewports: config.viewports.map(v => {
      // `height` is optional but persisted EXPLICITLY when set — including
      // the string `'auto'` (e.g. user picked Auto on the viewport-frame
      // Height row). Skipping `'auto'` here would erase the user's
      // intent from the @canvas block; the SizeTool relies on the
      // explicit string to know whether to write `height: 'auto'` back
      // onto the root div. `undefined`/`0`/`null` still get filtered —
      // those mean "field never set" and would only clutter the JSON.
      const out: Record<string, unknown> = {
        id: v.id, label: v.label, width: v.width,
        isPrimary: v.isPrimary || false, order: v.order ?? 0,
      };
      if (v.height === 'auto') {
        out.height = 'auto';
      } else if (typeof v.height === 'number' && v.height > 0) {
        out.height = v.height;
      }
      return out;
    }),
    positions: config.positions,
  }, null, 2);
  trace.fn('canvas-config:serialize', { viewportCount: config.viewports.length, positionKeys: Object.keys(config.positions) });
  return `/** @canvas ${json} */\n`;
}

/** Update or insert the @canvas block in code. */
export function updateCanvasConfigInCode(code: string, config: CanvasConfig): string {
  const block = serializeCanvasConfig(config);
  const match = code.match(CANVAS_BLOCK_REGEX);
  if (match) {
    trace.action('canvas-config:update', 'replace-existing');
    return code.replace(CANVAS_BLOCK_REGEX, block);
  }
  // Insert: after 'use client' line, or at top
  const useClientMatch = code.match(/^['"]use client['"];?\s*\n/m);
  if (useClientMatch) {
    const insertIdx = useClientMatch.index! + useClientMatch[0].length;
    trace.action('canvas-config:update', 'insert-after-use-client');
    return code.slice(0, insertIdx) + '\n' + block + code.slice(insertIdx);
  }
  trace.action('canvas-config:update', 'insert-at-top');
  return block + code;
}

/** Strip the @canvas comment block (for preview/publish). */
export function stripCanvasConfig(code: string): string {
  const had = CANVAS_BLOCK_REGEX.test(code);
  if (had) trace.action('canvas-config:strip', 'removed');
  return code.replace(CANVAS_BLOCK_REGEX, '');
}
