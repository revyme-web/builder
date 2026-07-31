// page-root-shell.ts — normalize a PAGE root's style at a template boundary.
//
// A templated page's `data-id="root"` COLLIDES with the template's own root in the canvas
// node map: the template's root styles win on the canvas, so anything authored on the page
// root is invisible in the editor but still renders on the live site. That divergence is how
// the double-scrollbar shipped (2026-07-28): the page root carried `overflowX: 'hidden'`
// under the Body template — dropped on canvas, but live it computes `overflow-y: auto`
// (CSS forbids one axis hidden while the other stays visible) and the root became a nested
// scroll container the moment a below-the-fold appear animation's `y: 24` initial offset
// poked 11px past the page bottom. Wheel input then hit the inner 11px scroller first —
// the "scroll blocks, then unblocks" trap.
//
// So: crossing INTO a template, the page root is reduced to the BARE canonical the oracle's
// TEMPLATED_PAGE_ROOT_STYLED rule prescribes — it keeps its flex column (the page still
// stacks its own sections, and order/drag semantics need a layout parent) and loses every
// shell prop (overflow, background, padding, min-height…) whose job now belongs to the
// template root. Crossing OUT, the root gets the standalone shell back — with
// `overflowX: 'clip'`, never 'hidden': clip clips sideways bleed (auras) identically but can
// NEVER become a scroll container, and unlike hidden it doesn't break position:sticky.
//
// Pure string → string; leaf module (parser + generator only) so the movePageFile primitive
// in active-file-store can call it without a dependency cycle.

import { parseJSXToNodes } from '../parsing/parser';
import { updateNodeInCode } from './generator-crud';
import { trace } from '@/shared/debug-trace';

/** The oracle's bare canonical for a templated page root (TEMPLATED_PAGE_ROOT_STYLED). */
export const TEMPLATED_PAGE_ROOT_STYLE: Record<string, string> = {
  position: 'relative',
  width: '100%',
  height: 'auto',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
};

/** A standalone page root is the outermost shell again — same bare layout plus the shell
 *  duties: horizontal clipping (clip, NOT hidden — see header) and the default background. */
export const STANDALONE_PAGE_ROOT_STYLE: Record<string, string> = {
  ...TEMPLATED_PAGE_ROOT_STYLE,
  overflowX: 'clip',
  backgroundColor: '#ffffff',
};

export function normalizePageRootShell(code: string, mode: 'templated' | 'standalone'): string {
  const target = mode === 'templated' ? TEMPLATED_PAGE_ROOT_STYLE : STANDALONE_PAGE_ROOT_STYLE;
  let existing: Record<string, string> = {};
  try {
    existing = parseJSXToNodes(code).get('root')?.styles ?? {};
  } catch {
    trace.error('page-root-shell:parse-failed', { mode });
    return code;
  }
  // One updateNodeInCode call: every current key not in the target is cleared (''), targets set.
  const patch: Record<string, string> = {};
  for (const k of Object.keys(existing)) patch[k] = '';
  Object.assign(patch, target);
  const changed = Object.keys(existing).some((k) => existing[k] !== target[k])
    || Object.keys(target).some((k) => existing[k] !== target[k]);
  if (!changed) return code;
  const out = updateNodeInCode(code, 'root', patch);
  trace.action('page-root-shell:normalize', {
    mode,
    stripped: Object.keys(existing).filter((k) => target[k] == null),
  });
  return out;
}
