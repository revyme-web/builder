// group-resize-bake.ts — Pure math for baking a group's children during a
// non-uniform resize. Shared by:
//   • the COMMIT (`refit-group.ts` → `scaleGroupChildrenSource`), and
//   • the LIVE preview (the iframe sandbox's `bakeGroupResize` handler).
//
// Keeping it here (deps: only `scale-geometry`) lets the sandbox import the
// exact same math WITHOUT pulling in `modifyProjectFile`/the jotai store, so
// live == commit byte-for-byte (no mouseup snap) and the sandbox bundle stays
// light.

import {
  scaleShapeGeometry, geometryBBox, translateShapeGeometry,
  transformShapeGeometry, rotatedScaleAffine,
} from '@/shared/svg-geometry';

/** Round to 3 decimals — rotation pivots / origins must NOT be integer-rounded
 *  (a 0.5px-off pivot makes a rotated child appear to slightly rotate, and a
 *  resize's opposite corner to creep). Box/viewBox keep it too so per-operation
 *  drift doesn't accumulate (an integer r3s back to an integer). */
export function r3(n: number): number { return Math.round(n * 1000) / 1000; }

export interface GroupChildSnapshot {
  childId: string;
  x: number; y: number; width: number; height: number;
  vbx: number; vby: number; vbw: number; vbh: number;
  geomId: string;
  geomTag: string;
  geomAttrs: Record<string, string>;
  rotate: { angle: number; cx: number; cy: number } | null;
}

export interface GroupResizeSnapshot {
  origVbW: number; origVbH: number;
  children: GroupChildSnapshot[];
}

export interface GroupChildLivePatch {
  childId: string;
  childAttrs: Record<string, string>;
  geomId: string;
  geomAttrs: Record<string, string>;
}

/** Parse a `rotate(a cx cy)` transform attribute. */
export function parseRotateTransform(transform: string | undefined): { angle: number; cx: number; cy: number } | null {
  const m = (transform || '').match(/rotate\(\s*(-?[\d.]+)[\s,]+(-?[\d.]+)[\s,]+(-?[\d.]+)\s*\)/);
  return m ? { angle: parseFloat(m[1]), cx: parseFloat(m[2]), cy: parseFloat(m[3]) } : null;
}

/**
 * Baked patches (child box + viewBox + geometry + rotate-pivot) for a given
 * scale, recomputed from the ORIGINAL snapshot (no accumulation). Used
 * IDENTICALLY by the live preview (sandbox) and the commit, so there is no snap.
 *
 * Non-rotated child: scale box + viewBox + geometry by (sx,sy) — its painted
 * content scales by (sx,sy) in group space, keeping the opposite group edge
 * pinned.
 *
 * ROTATED child (this is the reference trick): the group's scale must apply in the
 * GROUP frame, which on the child's un-rotated geometry is the scale+shear
 * matrix `M = R(-θ)·S·R(θ)`, with the rotate ANGLE preserved. Without this the
 * painted content doesn't scale uniformly and the opposite group edge drifts.
 * We transform the geometry by M (+ pivot scaled to S·pivot), then re-base to the
 * box=un-rotated-bbox convention so the child stays 1:1 and the position is
 * compensated for the re-base.
 */
export function computeScaledChildPatches(snap: GroupResizeSnapshot, scaleX: number, scaleY: number): GroupChildLivePatch[] {
  return snap.children.map((c) => {
    if (!c.rotate) {
      const childAttrs: Record<string, string> = {
        x: `${r3(c.x * scaleX)}`,
        y: `${r3(c.y * scaleY)}`,
        width: `${r3(c.width * scaleX)}`,
        height: `${r3(c.height * scaleY)}`,
        viewBox: `${r3(c.vbx * scaleX)} ${r3(c.vby * scaleY)} ${r3(c.vbw * scaleX)} ${r3(c.vbh * scaleY)}`,
      };
      const geomAttrs = scaleShapeGeometry(c.geomTag, c.geomAttrs, scaleX, scaleY);
      return { childId: c.childId, childAttrs, geomId: c.geomId, geomAttrs };
    }

    // Rotated child — the reference's trick: M = R(-θ)·S·R(θ) applied to the geometry
    // (the group scale expressed in the rotated frame, angle preserved), then:
    //   • the new box = the un-rotated bbox of the transformed geometry,
    //   • the rotate pivot = the new box CENTRE (resize convention), and
    //   • the child position is compensated so the painted content lands at
    //     exactly S·(original painted) — uniform group scale → opposite edge pinned.
    const { angle, cx, cy } = c.rotate;
    const affine = rotatedScaleAffine(angle, scaleX, scaleY, cx, cy);
    const transformed = transformShapeGeometry(c.geomTag, c.geomAttrs, affine);
    const gb = geometryBBox(c.geomTag, transformed) ?? { x: 0, y: 0, width: 0, height: 0 };
    const rebased = translateShapeGeometry(c.geomTag, transformed, -gb.x, -gb.y);
    const Cx = gb.width / 2, Cy = gb.height / 2;          // pivot = box centre
    const Kx = scaleX * cx - gb.x, Ky = scaleY * cy - gb.y; // painted-correct reference pivot
    // Moving the pivot K → C shifts the painted result by (I-R(θ))·(C-K);
    // cancel it in the position: childPos = S·oldPos + bboxOrigin + (I-R)·(K-C).
    const rad = (angle * Math.PI) / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    const dKx = Kx - Cx, dKy = Ky - Cy;
    const compX = dKx * (1 - cos) + dKy * sin;
    const compY = -dKx * sin + dKy * (1 - cos);
    const childAttrs: Record<string, string> = {
      x: `${r3(c.x * scaleX + gb.x + compX)}`,
      y: `${r3(c.y * scaleY + gb.y + compY)}`,
      width: `${r3(gb.width)}`,
      height: `${r3(gb.height)}`,
      viewBox: `0 0 ${r3(gb.width)} ${r3(gb.height)}`,
    };
    const geomAttrs: Record<string, string> = { ...rebased, transform: `rotate(${angle} ${r3(Cx)} ${r3(Cy)})` };
    return { childId: c.childId, childAttrs, geomId: c.geomId, geomAttrs };
  });
}
