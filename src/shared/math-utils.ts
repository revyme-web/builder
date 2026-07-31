// math-utils.ts — Tiny pure math helpers with zero imports (leaf module).
// `clamp` lives here (not canvas-math) so leaf-ish modules like
// TransformManager can use it without pulling canvas-math's node-ops
// dependency into a cycle.

/** Clamp a value between min and max. */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
