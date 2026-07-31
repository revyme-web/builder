// ruler-guides-config.ts — Per-file persistence for ruler guides.
// Same pattern as `canvas-config.ts`'s `/** @canvas {...} */` block:
// every page / component / icon-set master file can carry a single
// `/** @rulerGuides [...] *\/` JSDoc annotation that holds an array of
// `{ id, type, position }` objects. Round-tripping the guides through
// source code means each file's guides survive across reloads, sync to
// other devices on save, and live IN the project (cloned on duplicate,
// gone on delete) just like canvasNodes do.

export interface RulerGuide {
  /** Unique within the file. `guide-<timestamp>-<rand>` from the ops. */
  id: string;
  type: 'horizontal' | 'vertical';
  /** Canvas-space coordinate (CSS px relative to the page root, NOT
   *  screen px — survives canvas pan/zoom). */
  position: number;
}

const ANNOTATION_RE = /\/\*\*\s*@rulerGuides\s*(\[[\s\S]*?\])\s*\*\//;

/** Parse the `/** @rulerGuides [...] *\/` block from `code`. Returns an
 *  empty array when missing or malformed (defensive — better to lose
 *  the guides than crash the page render). */
export function parseRulerGuides(code: string): RulerGuide[] {
  const match = code.match(ANNOTATION_RE);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[1]);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((g): g is RulerGuide =>
      g && typeof g === 'object'
      && typeof g.id === 'string'
      && (g.type === 'horizontal' || g.type === 'vertical')
      && typeof g.position === 'number'
      && Number.isFinite(g.position),
    );
  } catch {
    return [];
  }
}

/** Format a guides array as the JSON body of an annotation block. */
function serializeRulerGuides(guides: RulerGuide[]): string {
  if (guides.length === 0) return '';
  const lines = guides.map(g =>
    `  { "id": "${g.id}", "type": "${g.type}", "position": ${Math.round(g.position * 100) / 100} }`,
  );
  return `/** @rulerGuides [\n${lines.join(',\n')}\n] */`;
}

/** Write `guides` into `code`'s `@rulerGuides` block. Replaces an
 *  existing block, or inserts a fresh one immediately after the
 *  `@canvas` block if present (so all editor-meta annotations live
 *  together at the top of the file). When `guides` is empty, removes
 *  the block entirely so we don't leave a stray empty annotation. */
export function updateRulerGuidesInCode(code: string, guides: RulerGuide[]): string {
  const serialized = serializeRulerGuides(guides);

  // Empty list → strip any existing block.
  if (guides.length === 0) {
    return code.replace(ANNOTATION_RE, '').replace(/\n{3,}/g, '\n\n');
  }

  // Replace an existing block in place.
  if (ANNOTATION_RE.test(code)) {
    return code.replace(ANNOTATION_RE, serialized);
  }

  // Insert after the `@canvas` block (`/** @canvas { ... } */`) so all
  // editor metadata clusters at the top of the file. Falls back to
  // injecting after the file's first JSDoc / `'use client'` line.
  const canvasRe = /(\/\*\*\s*@canvas\s*\{[\s\S]*?\}\s*\*\/)/;
  if (canvasRe.test(code)) {
    return code.replace(canvasRe, `$1\n\n${serialized}`);
  }
  // Last resort: prepend (after `'use client'` if present).
  const useClientRe = /^('use client';\s*\n)/;
  if (useClientRe.test(code)) {
    return code.replace(useClientRe, `$1\n${serialized}\n`);
  }
  return `${serialized}\n\n${code}`;
}
