// overlay-runtime-effects.ts — the runtime effects an overlay ships with
// (relative positioner, fixed backdrop/scroll-lock) and the load-time heal
// that upgrades old generated copies of them.
//
// A LEAF module on purpose: project-fs runs healOverlayTopLayerInCode while
// loading, and overlay-gen's own imports (generator-crud → generator-styles →
// stores) reach back into project-fs — importing overlay-gen there closes the
// cycle and the editor white-screens on boot. overlay-gen re-exports
// everything here, so its importers are unchanged.

import { trace } from '@/shared/debug-trace';
import { nodeIdToVarName } from '@/shared/id-utils';
import { parseOverlayCalls } from '../parsing/overlay-parser';

export function stateVarName(overlayId: string): string {
  return `${nodeIdToVarName(overlayId)}Open`;
}


/** JS expression that resolves the element for `idExpr` (a JS expression). */
export function findJs(idExpr: string, scoped: boolean): string {
  return scoped
    ? `ovFind(${idExpr})`
    : `document.querySelector('[data-id="' + ${idExpr} + '"]')`;
}
/** Same for a LITERAL id — the page form keeps the historical single string. */
export function findLitJs(id: string, scoped: boolean): string {
  return scoped ? `ovFind('${id}')` : `document.querySelector('[data-id="${id}"]')`;
}

// ─── Top layer ──────────────────────────────────────────────────────────────
// An overlay inside a component whose root is perf-isolated (`contain` +
// `willChange: 'transform'`, see variant-perf) was clipped on the live site:
// either property makes the root the containing block of its fixed children,
// and the root's overflow/paint containment cut the dropdown at the header's
// edge (user report 2026-10-20). The canvas portals overlays, so it looked fine
// there. A transform/filter/backdrop-filter on any ancestor does the same.
//
// The runtime now lifts the open overlay into the browser's TOP LAYER (Popover
// API, `popover="manual"` = no light dismiss): drawn above everything, its
// containing block is the viewport, and no ancestor clips it, while the element
// stays where it is in the DOM. So CSS ancestor selectors (`[data-variant] …`,
// `:lang()`), inherited styles, `ovFind`, React/DOM hover and an ancestor's
// `display: none` all behave exactly as before. Verified in Chromium against a
// portal (2026-10-21): same paint cost, and the portal broke ancestor hover,
// two selector shapes and breakpoint hides. Browsers without the API keep the
// old in-place rendering.
//
// The UA gives `[popover]` its own box (inset 0 + margin auto would centre it,
// plus border, padding, Canvas colours, overflow auto). A zero-specificity
// reset injected once puts every unset property back to what an in-place
// overlay had; anything the overlay sets itself still wins.
export const OVERLAY_TOP_LAYER_STYLE_ID = 'rv-overlay-top-layer';
export const OVERLAY_TOP_LAYER_CSS =
  ':where([data-overlay][popover]){inset:auto;margin:0;padding:0;border:0;color:inherit;background:none;overflow:visible;width:auto;height:auto}';

/** Emitted statement block: show `el` (a JS expression naming the overlay
 *  element) in the top layer once, guarded for older browsers and a re-open
 *  during the exit animation (the element is still showing). Never throws. */
function topLayerLiftJs(el: string, indent: string): string {
  return `${indent}if (${el} && ${el}.showPopover) {
${indent}  try {
${indent}    if (!document.getElementById('${OVERLAY_TOP_LAYER_STYLE_ID}')) { const s = document.createElement('style'); s.id = '${OVERLAY_TOP_LAYER_STYLE_ID}'; s.textContent = '${OVERLAY_TOP_LAYER_CSS}'; document.head.appendChild(s); }
${indent}    if (!${el}.matches(':popover-open')) { ${el}.setAttribute('popover', 'manual'); ${el}.showPopover(); }
${indent}  } catch {}
${indent}}
`;
}

/** The useEffect that powers a FIXED overlay (modal) at runtime. Reads its
 *  CONFIG from `data-overlay` (so panel edits to dismissible/pageScroll propagate
 *  without rewriting this effect) and: (a) closes on backdrop press when
 *  `dismissible !== false`, (b) locks body scroll while open unless
 *  `pageScroll === 'auto'`. Backdrop = a press whose target is the overlay
 *  element itself (not its content). fill/zIndex live in the element style
 *  (config-baked at create; the editor Renderer also applies them live). */
export function buildFixedOverlayRuntimeEffect(overlayId: string, scoped = false): string {
  const varName = stateVarName(overlayId);
  const setVarName = `set${varName.charAt(0).toUpperCase() + varName.slice(1)}`;
  return `  useEffect(() => {
    if (!${varName}) return;
    const overlay = ${findLitJs(overlayId, scoped)};
    if (!overlay) return;
${topLayerLiftJs('overlay', '    ')}    const cfg = JSON.parse(overlay.getAttribute('data-overlay') || '{}');
    if (cfg.fill) overlay.style.backgroundColor = cfg.fill;
    if (cfg.zIndex != null) overlay.style.zIndex = String(cfg.zIndex);
    const onBackdrop = (e) => { if (e.target === overlay && cfg.dismissible !== false) ${setVarName}(false); };
    overlay.addEventListener('mousedown', onBackdrop);
    const prevOverflow = document.body.style.overflow;
    if (cfg.pageScroll !== 'auto') document.body.style.overflow = 'hidden';
    return () => {
      overlay.removeEventListener('mousedown', onBackdrop);
      document.body.style.overflow = prevOverflow;
    };
  }, [${varName}]);
`;
}

/** The useLayoutEffect that positions a RELATIVE overlay from its trigger at
 *  runtime (responsive-aware). Shared by create (fresh) and rehydrate (trigger
 *  dragged back into a viewport) so both emit byte-identical runtime. */
/* The emitted dismiss handler carries NO comments on purpose: prose comments in
 * a page bounce the oracle's NO_COMMENTS_IN_GENERATED_CODE (the fast-path
 * generators splice JSX by character position, so an unexpected comment shifts
 * every offset). Documenting the behaviour HERE keeps the explanation without
 * shipping it into the user's file — a live page carried 3 of these
 * (user report 2026-07-26).
 *
 * What it does: pressing anywhere on the page closes the overlay, not only the
 * source. Trigger presses are ignored (the trigger's own handler toggles);
 * presses inside the overlay keep it open.
 *
 * Top layer (see topLayerLiftJs): the open overlay no longer moves with an
 * ancestor's transform, so instead of resize/scroll listeners it re-positions
 * on every animation frame while open — that follows a scroll, a resize AND a
 * header sliding away (hide-on-scroll). One getBoundingClientRect + one
 * offsetWidth/Height per frame per OPEN overlay; top/left are only written when
 * they change. Once the trigger has been on screen and then leaves it (scrolled
 * off, slid away, hidden), the overlay closes rather than sticking to the
 * collision edge. `seen` keeps an overlay whose trigger was never on screen
 * (opened by an event from elsewhere) from closing on its first frame. */
export function buildRelativeOverlayPosEffect(overlayId: string, scoped = false): string {
  const varName = stateVarName(overlayId);
  const setter = `set${varName.charAt(0).toUpperCase() + varName.slice(1)}`;
  return `  useLayoutEffect(() => {
    if (!${varName}) return;
    let seen = false;
    const position = () => {
      const overlay = ${findLitJs(overlayId, scoped)};
      if (!overlay) return;
      const raw = JSON.parse(overlay.getAttribute('data-overlay') || '{}');
      let cfg = raw;
      if (raw.responsive) {
        const ww = window.innerWidth;
        const bps = raw.responsiveBp;
        const owning = (bps && bps.length)
          ? bps.filter(b => ww <= b).sort((a, b) => a - b)[0]
          : Object.keys(raw.responsive).map(Number).filter(n => ww <= n).sort((a, b) => a - b)[0];
        if (owning !== undefined && raw.responsive[owning]) cfg = { ...raw, ...raw.responsive[owning] };
      }
      const trigger = ${findJs('cfg.triggerId', scoped)};
      if (!trigger) return;
      const r = trigger.getBoundingClientRect();
      const onScreen = trigger.getClientRects().length > 0 && r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth;
      if (onScreen) seen = true;
      else if (seen) { ${setter}(false); return; }
      const w = overlay.offsetWidth, h = overlay.offsetHeight;
      const g = 8, ox = cfg.offsetX || 0, oy = cfg.offsetY || 0;
      let top, left;
      switch (cfg.side || 'bottom') {
        case 'top': top = r.top - h - g + oy; break;
        case 'left': top = r.top + oy; left = r.left - w - g + ox; break;
        case 'right': top = r.top + oy; left = r.right + g + ox; break;
        default: top = r.bottom + g + oy;
      }
      if (left === undefined) {
        if (cfg.align === 'center') left = r.left + r.width / 2 - w / 2 + ox;
        else if (cfg.align === 'end') left = r.right - w + ox;
        else left = r.left + ox;
      } else if (cfg.align === 'center') top = r.top + r.height / 2 - h / 2 + oy;
      else if (cfg.align === 'end') top = r.bottom - h + oy;
      if (cfg.collision !== 'none') {
        const pad = cfg.collisionPadding ?? 20;
        left = Math.min(Math.max(left, pad), window.innerWidth - w - pad);
        top = Math.min(Math.max(top, pad), window.innerHeight - h - pad);
      }
      const t = top + 'px', l = left + 'px';
      if (overlay.style.top !== t) overlay.style.top = t;
      if (overlay.style.left !== l) overlay.style.left = l;
    };
    const onOutside = (e) => {
      const ov = ${findLitJs(overlayId, scoped)};
      if (ov && ov.contains(e.target)) return;
      const tid = ov ? (JSON.parse(ov.getAttribute('data-overlay') || '{}').triggerId) : null;
      const tr = tid ? ${findJs('tid', scoped)} : null;
      if (tr && tr.contains(e.target)) return;
      ${setter}(false);
    };
    const lift = ${findLitJs(overlayId, scoped)};
${topLayerLiftJs('lift', '    ')}    position();
    let raf = requestAnimationFrame(function follow() { position(); raf = requestAnimationFrame(follow); });
    document.addEventListener('mousedown', onOutside);
    return () => { cancelAnimationFrame(raf); document.removeEventListener('mousedown', onOutside); };
  }, [${varName}]);\n`;
}


/** Upgrade every GENERATED overlay runtime effect that predates the top layer
 *  (see topLayerLiftJs) to the current builder output, so overlays already in
 *  projects stop being clipped by a perf-isolated component root. Only effects
 *  carrying the builder's own signature are replaced: the relative positioner
 *  (data-overlay config read + `position` + the old scroll listener) or the
 *  fixed backdrop/scroll-lock effect. A hand-written effect is left alone. The
 *  effect is located like removeOverlayEffectBlock (its unique `, [<var>]);`
 *  deps) and swapped in place, so the useState above it never moves.
 *  Idempotent: the new output carries `showPopover`. */
export function healOverlayTopLayerInCode(code: string): string {
  if (!code.includes('data-overlay=')) return code;
  const overlays = parseOverlayCalls(code);
  if (overlays.length === 0) return code;
  let result = code;
  let upgraded = 0;
  for (const ov of overlays) {
    const varName = stateVarName(ov.overlayId);
    const dep = `, [${varName}]);`;
    const depIdx = result.indexOf(dep);
    if (depIdx < 0) continue;
    const before = result.slice(0, depIdx);
    const opener = Math.max(before.lastIndexOf('useLayoutEffect('), before.lastIndexOf('useEffect('));
    if (opener < 0) continue;
    const lineStart = result.lastIndexOf('\n', opener) + 1;
    // A reformatted file can carry code before the opener on the same line —
    // keep it, and drop the builder's own indent instead.
    const start = /^[ \t]*$/.test(result.slice(lineStart, opener)) ? lineStart : opener;
    let end = depIdx + dep.length;
    if (result[end] === '\n') end++;
    const block = result.slice(start, end);
    if (block.includes('showPopover')) continue;
    const readsConfig = block.includes(`getAttribute('data-overlay')`);
    const isRelative = readsConfig && block.includes('const position = ') && block.includes('getBoundingClientRect')
      && block.includes(`addEventListener('scroll', position, true)`);
    const isFixed = readsConfig && block.includes('prevOverflow') && block.includes('onBackdrop');
    if (isRelative === isFixed) continue;
    const scoped = block.includes(`ovFind('${ov.overlayId}')`);
    const effect = isFixed
      ? buildFixedOverlayRuntimeEffect(ov.overlayId, scoped)
      : buildRelativeOverlayPosEffect(ov.overlayId, scoped);
    result = result.slice(0, start) + (start === lineStart ? effect : effect.trimStart()) + result.slice(end);
    upgraded++;
  }
  if (upgraded) trace.action('overlay-gen:heal-top-layer', { upgraded });
  return result;
}
