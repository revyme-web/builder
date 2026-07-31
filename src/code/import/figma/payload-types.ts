// payload-types.ts — the "Import to Revyme" Figma plugin's clipboard payload
// (v5). Mirrors figma-plugin/src/types.ts verbatim: the plugin walks the
// user's selection and emits a FLAT node list with Figma's own getCSSAsync()
// styles (camelCased), raw SVG markup for vectors, and data-URL images.
// The plugin is a thin EXTRACTOR — all dialect translation happens here in
// the editor (see convert.ts), so the dialect can evolve without plugin
// releases through Figma's review queue.

export type FigmaNodeKind = 'div' | 'text' | 'svg' | 'img';

export interface FigmaPayloadNode {
  /** Figma node id, sanitized (lowercase, colons → underscores). */
  id: string;
  /** Figma layer name (verbatim — becomes data-name). */
  name: string;
  kind: FigmaNodeKind;
  /** getCSSAsync() output, camelCased keys, string values. */
  styles: Record<string, string>;
  /** Plain text content — kind 'text' only. */
  text?: string;
  /** Raw SVG markup — kind 'svg' only. */
  svg?: string;
  /** data:image/png;base64 URL — kind 'img', or a 'div' frame whose fills
   *  include an IMAGE paint (photo/texture layered with solids). */
  src?: string;
  /** Figma image-paint scale mode: FILL | FIT | TILE | CROP. */
  srcScaleMode?: string;
  /** IMAGE paint opacity when < 1 — figma keeps texture subtlety on the
   *  PAINT, not the node (the 100%-strength Background Noise find). */
  srcOpacity?: number;
  /** IMAGE paint blend mode when not NORMAL. */
  srcBlendMode?: string;
  /** TILE fills: css background-size reproducing figma's tile scale. */
  srcTileSize?: string;
  /** Child node ids in DOM order — kinds 'div'/'text'. */
  children?: string[];
}

export interface FigmaPayload {
  version: '5.0';
  source: 'figma-plugin';
  nodes: FigmaPayloadNode[];
  rootNodeIds: string[];
}

/** Is this JSON blob a plugin payload we understand? */
export function isFigmaPayload(v: unknown): v is FigmaPayload {
  const p = v as FigmaPayload;
  return !!p && p.source === 'figma-plugin' && p.version === '5.0'
    && Array.isArray(p.nodes) && Array.isArray(p.rootNodeIds);
}
