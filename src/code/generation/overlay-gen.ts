// overlay-gen.ts — Generate, update, and remove overlay code.
// Creates useState + trigger handler + conditional overlay block.
// All functions are pure: (code, config) → code.

import type { OverlayConfig, OverlayConfigOverride, OverlayConfigPatch, OverlayTriggerConfig } from '@/shared/types';
import { trace } from '@/shared/debug-trace';
import { quoteStyleValue, findTagClose, findJSXDataIdIndex, getJsonAttr } from './generator-utils';
import { parseOverlayCalls, parseOverlayTriggerCalls, resolveOverlayConfig } from '../parsing/overlay-parser';
import { findCanvasNodesFragmentClose, findExportDefaultEndIdx } from './generator-crud';
import { splitStyleProps } from '@/shared/css-utils';
import { escapeRegExp } from '@/shared/regex-utils';
import { nodeIdToVarName } from '@/shared/id-utils';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Given the index of an opening tag's `<`, return the index just past the
 * element's end — `/>` for self-closing, or the matching `</tag>` accounting
 * for same-tag nesting. Handles namespaced tags (`motion.div`). Returns -1 if
 * it can't be resolved.
 */
function findElementEnd(code: string, tagStart: number): number {
  const tagClosePos = findTagClose(code, tagStart);
  if (tagClosePos < 0) return -1;
  if (code[tagClosePos - 1] === '/') return tagClosePos + 1; // self-closing

  const tagNameMatch = code.slice(tagStart).match(/^<([\w.]+)/);
  const tagName = tagNameMatch ? tagNameMatch[1] : 'div';
  const openTag = `<${tagName}`;
  const closeTag = `</${tagName}>`;

  let nestDepth = 0;
  let searchFrom = tagClosePos + 1;
  while (searchFrom < code.length) {
    const nextOpen = code.indexOf(openTag, searchFrom);
    const nextClose = code.indexOf(closeTag, searchFrom);
    if (nextClose < 0) return -1;
    if (nextOpen >= 0 && nextOpen < nextClose) {
      const gt = findTagClose(code, nextOpen);
      if (gt >= 0 && code[gt - 1] === '/') searchFrom = gt + 1; // nested self-close
      else { nestDepth++; searchFrom = nextOpen + 1; }
    } else {
      if (nestDepth === 0) return nextClose + closeTag.length;
      nestDepth--;
      searchFrom = nextClose + 1;
    }
  }
  return -1;
}

/**
 * Remove the `{varName && ...}` conditional that wraps the overlay element.
 * Robust to BOTH generated forms:
 *   {varName && ( <div .../> )}
 *   {varName && <motion.div ...>...</motion.div>}
 * and to motion.* tags (an overlay gains an Appear animation → its `<div>`
 * becomes `<motion.div>`). Locates the overlay element by its data-id, finds
 * its full extent via tag matching, then expands outward to swallow the
 * surrounding `{ … && ( … )}`. No-op (returns code unchanged) when the
 * element isn't present or the wrapper isn't recognized — callers rely on the
 * empty-wrapper self-heal in removeOverlayInCode for the half-deleted case.
 */
/** Span of the overlay's full conditional block `{<var> && (<AnimatePresence>…
 *  </AnimatePresence>)}` (the AnimatePresence wrapper swallowed when present), or
 *  null if not found / unrecognized. Shared by remove (slice it out) and the
 *  make-component descendant transfer (slice it INTO the master). */
function findOverlayBlockSpan(code: string, overlayId: string, varName: string): { start: number; end: number } | null {
  const idIdx = findJSXDataIdIndex(code, overlayId);
  if (idIdx < 0) return null; // overlay element already gone
  const tagStart = code.lastIndexOf('<', idIdx);
  if (tagStart < 0) return null;
  const elementEnd = findElementEnd(code, tagStart);
  if (elementEnd < 0) return null;

  // Walk backward to the wrapping `{ varName && (` — the `(` is optional.
  let start = -1;
  let j = tagStart - 1;
  const skipWsBack = () => { while (j >= 0 && /\s/.test(code[j])) j--; };
  skipWsBack();
  if (code[j] === '(') { j--; skipWsBack(); }
  if (code[j] === '&' && code[j - 1] === '&') {
    j -= 2; skipWsBack();
    if (code.slice(j - varName.length + 1, j + 1) === varName) {
      j -= varName.length; skipWsBack();
      if (code[j] === '{') start = j;
    }
  }
  if (start < 0) return null; // unrecognized wrapper — leave untouched

  // Walk forward past the optional `)` and the closing `}`.
  let end = elementEnd;
  const skipWsFwd = () => { while (end < code.length && /\s/.test(code[end])) end++; };
  skipWsFwd();
  if (code[end] === ')') { end++; skipWsFwd(); }
  if (code[end] !== '}') return null; // malformed — bail
  end++;

  // Swallow a wrapping `<AnimatePresence>…</AnimatePresence>` (relative overlays
  // get one for enter/exit) so removing/extracting doesn't leave an empty
  // `<AnimatePresence></AnimatePresence>` behind.
  const apOpen = code.slice(0, start).match(/<AnimatePresence[^>]*>\s*$/);
  if (apOpen) {
    const apClose = code.slice(end).match(/^\s*<\/AnimatePresence>/);
    if (apClose) {
      start -= apOpen[0].length;
      end += apClose[0].length;
    }
  }
  return { start, end };
}

/** Remove a BARE overlay element `<… data-id="<overlayId>" data-overlay=…>…</…>`
 *  (a static CANVAS overlay — no `{var && (…)}` conditional), plus leading whitespace.
 *  Used to sweep an orphaned canvas overlay off the page after its trigger is
 *  extracted into a component. */
function removeBareOverlayElement(code: string, overlayId: string): string {
  const idIdx = findJSXDataIdIndex(code, overlayId);
  if (idIdx < 0) return code;
  const tagStart = code.lastIndexOf('<', idIdx);
  const elEnd = findElementEnd(code, tagStart);
  if (tagStart < 0 || elEnd < 0) return code;
  let s = tagStart;
  while (s > 0 && /[ \t]/.test(code[s - 1])) s--;
  if (s > 0 && code[s - 1] === '\n') s--;
  return code.slice(0, s) + code.slice(elEnd);
}

function removeOverlayConditionalBlock(code: string, overlayId: string, varName: string): string {
  const span = findOverlayBlockSpan(code, overlayId, varName);
  if (!span) return code;
  trace.action('overlay-gen:remove:block', { overlayId, start: span.start, end: span.end });
  return code.slice(0, span.start) + code.slice(span.end);
}

export function stateVarName(overlayId: string): string {
  return `${nodeIdToVarName(overlayId)}Open`;
}

// Default appear transitions for a fixed overlay (mirrors OverlayTool's defaults).
const DEFAULT_ENTER_TRANSITION: Record<string, string> = { type: 'tween', duration: '0.3', ease: 'easeIn' };
const DEFAULT_EXIT_TRANSITION: Record<string, string> = { type: 'tween', duration: '0.3', ease: 'easeOut' };

/** Format a framer-motion transition (flat string map from TransitionPanel) as a
 *  JSX object literal: numbers + bezier arrays stay bare, names get quoted —
 *  `{ type: 'tween', duration: 0.3, ease: 'easeIn' }`. */
function formatTransitionJSX(t: Record<string, string>): string {
  const entries = Object.entries(t)
    .filter(([, v]) => v !== '' && v != null)
    .map(([k, v]) => {
      if (/^\[.*\]$/.test(v.trim())) return `${k}: ${v}`;        // cubic-bezier array
      if (/^-?[0-9]*\.?[0-9]+$/.test(v.trim())) return `${k}: ${v}`; // number
      return `${k}: '${v}'`;                                      // string (type / ease name)
    });
  return `{ ${entries.join(', ')} }`;
}

/** Build position styles for the overlay.
 * Relative overlays: position absolute inside trigger (CSS-based).
 * Fixed overlays (modals): position fixed with backdrop. */
function buildPositionStyles(config: OverlayConfig): Record<string, string> {
  if (config.type === 'fixed') {
    // Full-viewport modal backdrop. Config-driven: `fill` (scrim) + `zIndex`.
    // Flex-centers its content (the reference modal default). On the canvas the Renderer
    // re-sizes height to the tile; `100vh` covers the browser viewport on publish.
    return {
      position: 'fixed',
      left: '0',
      top: '0',
      width: '100%',
      height: '100vh',
      zIndex: String(config.zIndex ?? 100),
      backgroundColor: config.fill ?? 'rgba(0, 0, 0, 0.5)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
    };
  }

  // position: fixed — immune to parent overflow/transform.
  // Actual top/left set by useLayoutEffect at runtime (both live + canvas).
  return {
    position: 'fixed',
    zIndex: '50',
  };
}

/** Format styles as JSX style attribute string: style={{ key: 'val', ... }} */
function formatStyleAttr(styles: Record<string, string>, indent: string): string {
  const entries = Object.entries(styles).map(([k, v]) => {
    const camel = k.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    return `${indent}  ${camel}: ${quoteStyleValue(v)}`;
  });
  return `style={{\n${entries.join(',\n')}\n${indent}}}`;
}

// ─── Find insertion helpers ──────────────────────────────────────────────────

function findReturnIdx(code: string): number {
  let searchFrom = 0;
  while (searchFrom < code.length) {
    const idx = code.indexOf('return ', searchFrom);
    if (idx < 0) break;
    const after = code.slice(idx + 7).trimStart();
    if (after.startsWith('<') || (after.startsWith('(') && !after.startsWith('()'))) return idx;
    searchFrom = idx + 7;
  }
  return -1;
}

/** Find position to insert useState + useLayoutEffect at the TOP LEVEL of the component.
 * Finds the line right after `export default function X() {` or after existing top-level useState. */
/** Position just AFTER the EXPORTED component function's body `{`. Handles BOTH
 *  a page (`export default function X(){`) AND a design component (`function
 *  Name(){} + export default withResponsiveProps(Name)`, or bare `export default
 *  Name`). Balanced-paren scan so a param default containing parens doesn't break
 *  it. Mirrors connection-config's findBodyBraceIdx. -1 if not found. */
function findComponentBodyStart(code: string): number {
  const exportName = code.match(/export default function (\w+)/)?.[1]
    ?? code.match(/export default \w+\((\w+)\)\s*;/)?.[1]   // withResponsiveProps(Name)
    ?? code.match(/export default (\w+)\s*;/)?.[1];          // bare Name
  const startRe = exportName
    ? new RegExp(`function ${exportName}\\s*\\(`)
    : /export default function\s*\w*\s*\(/;
  const m = startRe.exec(code);
  if (!m) return -1;
  let i = m.index + m[0].length - 1; // at the opening '(' of the param list
  let depth = 0;
  for (; i < code.length; i++) {
    if (code[i] === '(') depth++;
    else if (code[i] === ')') { depth--; if (depth === 0) { i++; break; } }
  }
  while (i < code.length && code[i] !== '{') i++; // skip optional return type to body '{'
  return i < code.length ? i + 1 : -1;
}

function findStateInsertPos(code: string): number {
  // Component-aware (pages AND design components) — `export default function`
  // alone misses `function Name(){} + export default withResponsiveProps(Name)`,
  // which left overlays in components with no useState → undefined-identifier
  // crash on the conditional.
  const funcBodyStart = findComponentBodyStart(code);
  if (funcBodyStart < 0) return -1;

  // Walk the body line by line FROM THE CURSOR, skipping the hook prologue
  // (blank lines, `const [x, setX] = useState(…)`, whole useEffect /
  // useLayoutEffect blocks) and stopping at the render `return`.
  //
  // Cursor-driven, NOT `split('\n')`-driven: the old loop iterated an array of
  // lines while a separate `insertOffset` jumped over entire hook blocks, so
  // after the first skip the line being INSPECTED no longer matched the byte
  // offset being ADVANCED. It usually broke out immediately and looked right,
  // which is why it survived so long.
  const body = code.slice(funcBodyStart);
  let offset = 0;

  while (offset < body.length) {
    const nl = body.indexOf('\n', offset);
    const lineEnd = nl < 0 ? body.length : nl;
    const trimmed = body.slice(offset, lineEnd).trim();

    if (trimmed.startsWith('return ') || trimmed.startsWith('return(')) break;

    if (trimmed.startsWith('useLayoutEffect') || trimmed.startsWith('useEffect')) {
      // Skip the whole hook block: brace-match its body, then step past `);`.
      let depth = 0;
      let i = offset;
      let foundStart = false;
      for (; i < body.length; i++) {
        if (body[i] === '{') { depth++; foundStart = true; }
        else if (body[i] === '}') { depth--; if (foundStart && depth === 0) break; }
      }
      const afterBrace = body.indexOf(');', i);
      if (afterBrace < 0) break;
      offset = afterBrace + 2;
      // Advance to the NEXT LINE only when the rest of THIS one is blank.
      //
      // Babel's printer routinely emits `}, [xOpen]);  return <div … style={{`
      // on a SINGLE line once a page has been regenerated. The old code jumped
      // to "the next newline" unconditionally — which on such a line is the one
      // AFTER `style={{`, so the new `const [ … ] = useState(false)` and its
      // effect were spliced INSIDE the root element's style object literal.
      // That's a hard SyntaxError: the page parses to zero nodes and the whole
      // canvas goes blank. It only reproduced on a page that ALREADY had an
      // overlay (nothing else takes this branch), which is exactly why a fresh
      // project looked fine and the big landing page died. Live find
      // 2026-07-25.
      let j = offset;
      while (j < body.length && (body[j] === ' ' || body[j] === '\t' || body[j] === '\r')) j++;
      if (j < body.length && body[j] === '\n') offset = j + 1;
      continue;
    }

    if (trimmed === '' || trimmed.startsWith('const [')) {
      offset = lineEnd + 1;
      continue;
    }

    break;
  }

  trace.fn('overlay-gen:findStateInsertPos', { funcBodyStart, offset });
  return funcBodyStart + offset;
}

// ─── Code Manipulation ──────────────────────────────────────────────────────

/** The trigger's event handler attr that toggles the overlay's open state. */
/** Append attribute string(s) to an OPENING tag (the slice WITHOUT the closing
 *  `>`). Handles a SELF-CLOSING tag — `<Comp … /` — by inserting BEFORE the `/`
 *  (and the whitespace before it) so the result stays valid `<Comp … attrs />`,
 *  not the broken `<Comp … / attrs>`. */
function appendAttrsToOpeningTag(tag: string, attrs: string): string {
  const m = tag.match(/\s*\/\s*$/);
  if (m && m.index !== undefined) return tag.slice(0, m.index) + attrs + tag.slice(m.index);
  return tag + attrs;
}

/** Position to insert attributes just before a tag's closing `>` at `closePos`.
 *  For a self-closing `… />` it returns the index before the `/` (skipping the
 *  whitespace before it) so attrs land BEFORE the slash. */
function attrInsertPosBeforeClose(code: string, closePos: number): number {
  if (code[closePos - 1] !== '/') return closePos;
  let p = closePos - 1;
  while (p > 0 && /\s/.test(code[p - 1])) p--;
  return p;
}

function buildOverlayHandlerAttr(triggerConfig: OverlayTriggerConfig, overlayId: string): string {
  const varName = stateVarName(overlayId);
  const setVarName = `set${varName.charAt(0).toUpperCase() + varName.slice(1)}`;
  // EVENT trigger: the trigger is a component INSTANCE, and the overlay opens when a
  // component EVENT fires from inside it. Pass the event callback as a PROP — the
  // master forwards it (`{...rest}`) to a child wired with `onClick={eventName}`, so
  // firing the child fires this callback and opens the overlay.
  if (triggerConfig.trigger === 'event' && triggerConfig.eventName) {
    return ` ${triggerConfig.eventName}={() => ${setVarName}(true)}`;
  }
  if (triggerConfig.trigger === 'click') return ` onClick={() => ${setVarName}(!${varName})}`;
  // HOVER: open on enter; on leave, DON'T close if the cursor moved ONTO the
  // overlay (the hover bridge). Critical for a FIXED modal — it covers the
  // trigger the instant it opens, so a naive `onMouseLeave={() => close}` fired
  // immediately and flickered the modal shut. The overlay carries the mirror
  // handler (close when leaving it, unless back onto the trigger).
  //
  // GRACE PERIOD: a relative overlay sits `side`+offset AWAY from its trigger,
  // so the cursor must cross a dead gap to reach it — relatedTarget there is
  // the page, and an instant close made dropdowns unreachable ("closes while
  // I move toward it"). Leave arms a shared per-overlay close timer
  // (window.__ovGrace, keyed by overlay id — inline handlers have no ref
  // scope) and any enter on either side cancels it. 180ms crosses any sane
  // gap without feeling laggy.
  return ` onMouseEnter={() => { ${graceCancelJs(overlayId)} ${setVarName}(true); }} onMouseLeave={(e) => { const ov = document.querySelector('[data-id="${overlayId}"]'); if (ov && e.relatedTarget && ov.contains(e.relatedTarget)) return; ${graceArmJs(overlayId, setVarName)} }}`;
}

/** Cancel a pending grace-close for this overlay (runs on either side's enter). */
function graceCancelJs(overlayId: string): string {
  return `clearTimeout(((window as any).__ovGrace ||= {})['${overlayId}']);`;
}

/** Arm the delayed close — 180ms lets the cursor cross the trigger↔overlay gap. */
function graceArmJs(overlayId: string, setVarName: string): string {
  return `const g = ((window as any).__ovGrace ||= {}); clearTimeout(g['${overlayId}']); g['${overlayId}'] = setTimeout(() => ${setVarName}(false), 180);`;
}

/** Strip overlay click/hover handlers (onClick / onMouseEnter / onMouseLeave)
 *  that reference `setter`, with BALANCED braces — so the new hover-bridge form
 *  `onMouseLeave={(e) => { … }}` is removed too, not just the simple
 *  `onMouseLeave={() => set(false)}`. Leaves unrelated handlers alone. */
function stripOverlayHandlers(text: string, setter: string): string {
  // Strip ANY `<ident>={…}` attribute whose VALUE references this overlay's unique
  // `set…Open` — covers `onClick`/`onMouseEnter`/`onMouseLeave` (click/hover triggers)
  // AND the `<eventName>={() => set…Open(true)}` prop (component-event triggers). The
  // setter name is unique per overlay, so this never strips an unrelated attribute
  // (e.g. `style`/`variants` don't reference it). Re-scan from scratch after each
  // removal since indices shift.
  let result = text;
  const attrRe = /\b([A-Za-z_][\w]*)=\{/g;
  for (let changed = true; changed; ) {
    changed = false;
    attrRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = attrRe.exec(result)) !== null) {
      const attrIdx = m.index;
      const braceStart = attrIdx + m[0].length - 1; // at the '{'
      let depth = 0, i = braceStart;
      for (; i < result.length; i++) {
        if (result[i] === '{') depth++;
        else if (result[i] === '}') { depth--; if (depth === 0) { i++; break; } }
      }
      if (result.slice(braceStart, i).includes(setter)) {
        const start = attrIdx > 0 && result[attrIdx - 1] === ' ' ? attrIdx - 1 : attrIdx;
        result = result.slice(0, start) + result.slice(i);
        changed = true;
        break; // restart scan (indices shifted)
      }
    }
  }
  return result;
}

/** The mirror hover handler that lives ON the overlay element: close when the
 *  cursor leaves the overlay, UNLESS it moved back onto the trigger. Empty for
 *  non-hover triggers. */
function buildOverlayHoverMirrorAttr(triggerConfig: OverlayTriggerConfig, overlayId: string, triggerId: string): string {
  if (triggerConfig.trigger !== 'hover') return '';
  const varName = stateVarName(overlayId);
  const setVarName = `set${varName.charAt(0).toUpperCase() + varName.slice(1)}`;
  // Same grace-period close as the trigger side (see buildOverlayHandlerAttr)
  // — entering the overlay cancels the trigger's pending close, and leaving
  // it back across the gap toward the trigger must not insta-close either.
  return ` onMouseEnter={() => { ${graceCancelJs(overlayId)} ${setVarName}(true); }} onMouseLeave={(e) => { const tr = document.querySelector('[data-id="${triggerId}"]'); if (tr && e.relatedTarget && tr.contains(e.relatedTarget)) return; ${graceArmJs(overlayId, setVarName)} }}`;
}

/** The useEffect that powers a FIXED overlay (modal) at runtime. Reads its
 *  CONFIG from `data-overlay` (so panel edits to dismissible/pageScroll propagate
 *  without rewriting this effect) and: (a) closes on backdrop press when
 *  `dismissible !== false`, (b) locks body scroll while open unless
 *  `pageScroll === 'auto'`. Backdrop = a press whose target is the overlay
 *  element itself (not its content). fill/zIndex live in the element style
 *  (config-baked at create; the editor Renderer also applies them live). */
export function buildFixedOverlayRuntimeEffect(overlayId: string): string {
  const varName = stateVarName(overlayId);
  const setVarName = `set${varName.charAt(0).toUpperCase() + varName.slice(1)}`;
  const esc = escapeRegExp(overlayId);
  void esc;
  return `  useEffect(() => {
    if (!${varName}) return;
    const overlay = document.querySelector('[data-id="${overlayId}"]');
    if (!overlay) return;
    const cfg = JSON.parse(overlay.getAttribute('data-overlay') || '{}');
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
 * presses inside the overlay keep it open. */
export function buildRelativeOverlayPosEffect(overlayId: string): string {
  const varName = stateVarName(overlayId);
  const setter = `set${varName.charAt(0).toUpperCase() + varName.slice(1)}`;
  return `  useLayoutEffect(() => {
    if (!${varName}) return;
    const position = () => {
      const overlay = document.querySelector('[data-id="${overlayId}"]');
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
      const trigger = document.querySelector('[data-id="' + cfg.triggerId + '"]');
      if (!trigger) return;
      const r = trigger.getBoundingClientRect();
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
      overlay.style.top = top + 'px';
      overlay.style.left = left + 'px';
    };
    const onOutside = (e) => {
      const ov = document.querySelector('[data-id="${overlayId}"]');
      if (ov && ov.contains(e.target)) return;
      const tid = ov ? (JSON.parse(ov.getAttribute('data-overlay') || '{}').triggerId) : null;
      const tr = tid ? document.querySelector('[data-id="' + tid + '"]') : null;
      if (tr && tr.contains(e.target)) return;
      ${setter}(false);
    };
    position();
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    document.addEventListener('mousedown', onOutside);
    return () => { window.removeEventListener('resize', position); window.removeEventListener('scroll', position, true); document.removeEventListener('mousedown', onOutside); };
  }, [${varName}]);\n`;
}

/** Insert an overlay's conditional JSX block as the LAST child of the page root
 *  (`data-id="root"`) — outside the trigger so it escapes overflow/transform.
 *  Falls back to `fallbackPos` when the root/return can't be located. */
/** True when `triggerTagStart` is the OUTERMOST element of a design-component
 *  master return (the variant-root) — i.e. only `return (` + transparent wrappers
 *  (LayoutGroup/MotionConfig) precede it, and there's no page `data-id="root"`
 *  container. Such a trigger has no parent box to hold the overlay, so the overlay
 *  must go INSIDE it (last child) rather than after it — a sibling there is
 *  parentless and the variant-root detector grabs it as a phantom variant. */
function triggerIsComponentVariantRoot(code: string, triggerTagStart: number): boolean {
  if (code.includes('data-id="root"')) return false; // a page has its own root container
  const returnIdx = findReturnIdx(code);
  if (returnIdx < 0 || triggerTagStart < returnIdx) return false;
  const between = code.slice(returnIdx, triggerTagStart)
    .replace(/return\s*\(?/, '')
    .replace(/<(?:LayoutGroup|MotionConfig)[^>]*>/g, '');
  return between.trim() === '';
}

/**
 * Insert `overlayContent` as the LAST CHILD of the page root (`data-id="root"`).
 *
 * STRUCTURAL scan — locate the root element and step back to its own closing
 * tag. The previous implementation sliced the return statement at the FIRST `;`
 * after the root's opening `>` and required that slice to END in a closing tag.
 * Any `;` inside the JSX broke it: a `<style>{`…`}</style>` block of `@media`
 * rules (the responsive system writes one into every page that has a replica
 * override), an inline arrow body, an `&nbsp;` entity. The region was then
 * truncated mid-element, the match failed, and EVERY overlay silently fell back
 * to `fallbackPos` — landing next to its trigger, deep inside a section.
 *
 * That misplacement is invisible for a RELATIVE overlay (the Renderer portals it
 * out) but breaks a FIXED/modal one, which is deliberately left in the viewport
 * tree and re-anchored `position: absolute; inset 0; height: <tile>` — so it
 * sizes against the SECTION's containing block and gets clipped by that
 * section's `overflow: hidden` instead of covering the tile. Live find
 * 2026-07-25 ("fixed overlay doesn't appear at the top of the page").
 */
function findRootCloseTagStart(code: string): number {
  // JSX-aware lookup — a raw `data-id="root"` match would also hit the
  // `[data-id="…"]` CSS selectors inside the page's `<style>` block.
  const rootIdx = findJSXDataIdIndex(code, 'root');
  if (rootIdx < 0) return -1;
  const rootTagStart = code.lastIndexOf('<', rootIdx);
  const rootEnd = findElementEnd(code, rootTagStart);
  if (rootEnd <= rootTagStart) return -1;
  // `findElementEnd` returns just past `</div>`; step back to that tag's `<`.
  const closeStart = code.lastIndexOf('</', rootEnd);
  return closeStart > rootTagStart ? closeStart : -1;
}

/**
 * @param fallbackPos  where to splice when root's closing tag can't be resolved.
 *                     Pass -1 to make failure a NO-OP (returns `code` unchanged).
 * @param minInsertPos the splice must land at or after this byte offset, or the
 *                     fallback is used. Callers that pre-measured other insert
 *                     positions (createOverlayInCode's bottom-to-top steps) pass
 *                     their earliest one so this splice can't shift it. 0 = no
 *                     constraint.
 */
function insertOverlayContentAsRootLastChild(
  code: string,
  overlayContent: string,
  fallbackPos: number,
  minInsertPos = 0,
): string {
  const closeStart = findRootCloseTagStart(code);
  if (closeStart >= 0 && closeStart >= minInsertPos) {
    trace.action('overlay-gen:insert-as-root-last-child', { closeStart, minInsertPos });
    return code.slice(0, closeStart) + overlayContent + '\n    ' + code.slice(closeStart);
  }
  if (fallbackPos < 0) {
    // NO-OP mode (the heal path). Appending at EOF here would drop the block
    // OUTSIDE the component function — module-scope JSX referencing a hook
    // variable, i.e. a broken page. Leaving it where it is is always safer.
    trace.error('overlay-gen:root-close-unresolved-noop', { closeStart, minInsertPos });
    return code;
  }
  trace.action('overlay-gen:insert-at-fallback', { closeStart, fallbackPos, minInsertPos });
  return code.slice(0, fallbackPos) + overlayContent + code.slice(fallbackPos);
}

/**
 * Create an overlay for a trigger element.
 * Generates: useState + onClick handler + conditional overlay div.
 * Uses a robust approach: builds all pieces first, then inserts them in reverse order
 * (bottom-to-top) so positions don't shift.
 */
export function createOverlayInCode(
  code: string,
  triggerId: string,
  overlayId: string,
  overlayConfig: OverlayConfig,
  triggerConfig: OverlayTriggerConfig,
  /** PASTE reattach: reuse a copied overlay's own styles + child JSX instead of
   *  building the default empty box. `styles` is the (already-sanitized) style
   *  object for the overlay element; `inner` is the raw child JSX between the
   *  overlay's `>` and `</motion.div>`. See `reattachPastedOverlayInCode`. */
  preserved?: { styles: Record<string, string>; inner: string },
): string {
  trace.fn('overlay-gen:create', { triggerId, overlayId, type: overlayConfig.type });

  const varName = stateVarName(overlayId);
  const setVarName = `set${varName.charAt(0).toUpperCase() + varName.slice(1)}`;

  // Clean up any stale overlay-trigger attr on this trigger element
  const triggerIdStr = `data-id="${triggerId}"`;
  let result = code;
  // Only remove trigger attr if it's near this specific trigger's data-id
  const staleTriggerMatch = result.match(new RegExp(`(${escapeRegExp(triggerIdStr)}[^>]*)\\s*data-overlay-trigger='[^']*'`));
  if (staleTriggerMatch) {
    result = result.replace(staleTriggerMatch[0], staleTriggerMatch[1]);
  }
  // Also clean stale onClick handlers for old overlay vars
  const staleOnClick = result.match(new RegExp(`(${escapeRegExp(triggerIdStr)}[^>]*)\\s*onClick=\\{\\(\\)\\s*=>\\s*set\\w+\\(!\\w+\\)\\}`));
  if (staleOnClick) {
    result = result.replace(staleOnClick[0], staleOnClick[1]);
  }

  // --- Step 1: Find all insertion points BEFORE modifying ---

  // JSX-aware lookup — a raw indexOf would match `[data-id="x"]` CSS selectors
  // inside any `<style>` block (e.g. the container-query hide rules) before the
  // real element, splicing handlers into the wrong place.
  const triggerIdx = findJSXDataIdIndex(result, triggerId);
  if (triggerIdx < 0) { trace.error('overlay-gen:create:trigger-not-found', { triggerId }); return result; }

  // Find trigger tag start and tag-closing >
  const tagStart = result.lastIndexOf('<', triggerIdx);
  let depth = 0;
  let tagClosePos = -1;
  for (let i = tagStart; i < result.length; i++) {
    if (result[i] === '{') depth++;
    else if (result[i] === '}') depth--;
    else if (result[i] === '>' && depth === 0) { tagClosePos = i; break; }
  }
  if (tagClosePos < 0) { trace.error('overlay-gen:create:no-tag-close', { triggerId }); return result; }

  // Find trigger element's end (closing tag or self-close) via shared helper.
  const elementEnd = findElementEnd(result, tagStart);
  const elementEndPos = elementEnd >= 0 ? elementEnd : tagClosePos + 1;

  // Find position for useState (before return statement)
  const statePos = findStateInsertPos(result);
  if (statePos < 0) { trace.error('overlay-gen:create:no-state-pos', { triggerId }); return result; }

  // --- Step 2: Build all pieces ---

  const triggerAttr = ` data-overlay-trigger='${JSON.stringify(triggerConfig)}'`;
  const handlerAttr = buildOverlayHandlerAttr(triggerConfig, overlayId);

  const posStyles = buildPositionStyles(overlayConfig);
  const indent = '      ';
  // FIXED width + height (not min-height): the portal/runtime positioning math
  // reads offsetWidth/offsetHeight for align/collision — an auto-growing box
  // shifts under the cursor and breaks collision clamping.
  // A plain literal color — NOT `var(--bg-surface, …)`. `--bg-surface` is an
  // EDITOR token that doesn't exist in the canvas iframe / published site, so
  // it always fell back to the literal anyway, and the Fill control showed the
  // raw `var(--bg-surface, #1a1a1a)` string (confusing, un-editable as a swatch).
  const allStyles = overlayConfig.type === 'fixed' ? posStyles : {
    ...posStyles,
    width: '200px',
    height: '100px',
    backgroundColor: '#7CBFFF',
    borderRadius: '8px',
    border: '1px solid rgba(255,255,255,0.1)',
    boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
  };

  // Fixed overlay: plain backdrop div (user adds children inside).
  // Relative overlay: a `motion.div` wrapped in `<AnimatePresence>` so it gets
  // BOTH an enter (initial→animate) and an EXIT animation on close (the reference
  // parity — a bare `{open && <div/>}` can't animate out). `exit` defaults to a
  // mirror of `initial` (linked); the Appear editor can unlink them. The `key`
  // is required for AnimatePresence to track mount/unmount.
  // FIXED (modal): AnimatePresence + motion.div backdrop, opacity fade with
  // per-direction TRANSITION from config (enter/exit — full Instant/Ease/Spring
  // objects), config-baked fill/zIndex in the style. Behaviour (backdrop-dismiss,
  // body-lock) is in the runtime effect.
  const enterT = formatTransitionJSX(overlayConfig.enterTransition ?? DEFAULT_ENTER_TRANSITION);
  const exitT = formatTransitionJSX(overlayConfig.exitTransition ?? DEFAULT_EXIT_TRANSITION);
  // Hover bridge mirror handler ON the overlay (empty for click triggers).
  const hoverMirror = buildOverlayHoverMirrorAttr(triggerConfig, overlayId, triggerId);
  // Fixed = opacity fade with per-direction transition; relative = opacity + slide.
  const appearAttrs = overlayConfig.type === 'fixed'
    ? `initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: ${exitT} }} transition={${enterT}}`
    : `initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 20 }}`;
  // PASTE reattach reuses the copied overlay's own styles + child JSX; a fresh
  // create uses the default box styles + empty body.
  const elementStyles = preserved ? preserved.styles : allStyles;
  const innerJsx = preserved && preserved.inner.trim() ? preserved.inner : `\n${indent}  `;
  // Overlays get `data-name="Overlay"` — without it the parser falls back to the
  // tag and the layer row read "div".
  const overlayContent = `\n${indent}<AnimatePresence>{${varName} && (\n${indent}  <motion.div key="${overlayId}" data-id="${overlayId}" data-name="Overlay" data-overlay='${JSON.stringify(overlayConfig)}' ${appearAttrs}${hoverMirror} ${formatStyleAttr(elementStyles, indent)}>${innerJsx}</motion.div>\n${indent})}</AnimatePresence>`;

  const stateDecl = `  const [${varName}, ${setVarName}] = useState(false);\n`;

  // --- Step 3: Apply changes bottom-to-top (so positions don't shift) ---
  trace.action('overlay-gen:create:positions', { tagStart, tagClosePos, elementEndPos, statePos, selfClosing: result[tagClosePos - 1] === '/' });

  // 3a. Insert overlay as last child of the ROOT CONTAINER so it's PARENTED.
  // Page: inside `data-id="root"`. Component master whose trigger IS the variant-
  // root: inside the trigger itself (its last child) — a sibling there would be a
  // parentless LayoutGroup node that the variant-root detector grabs as a phantom
  // variant. position:fixed + the editor portal still escape the root's overflow.
  // Component CHILD triggers keep the existing path (the overlay lands inside the
  // variant-root, parented, already correct).
  if (triggerIsComponentVariantRoot(result, tagStart)) {
    const closeIdx = result.lastIndexOf('</', elementEndPos); // start of the root's closing tag
    if (closeIdx > tagClosePos) {
      result = result.slice(0, closeIdx) + overlayContent + '\n    ' + result.slice(closeIdx);
    } else {
      result = insertOverlayContentAsRootLastChild(result, overlayContent, elementEndPos, elementEndPos);
    }
  } else {
    result = insertOverlayContentAsRootLastChild(result, overlayContent, elementEndPos, elementEndPos);
  }

  // 3b. Insert trigger attrs before tag-closing > (BEFORE the `/` on a
  //     self-closing instance tag like `<Comp … />`, else it breaks the JSX).
  {
    const attrPos = attrInsertPosBeforeClose(result, tagClosePos);
    result = result.slice(0, attrPos) + triggerAttr + handlerAttr + result.slice(attrPos);
  }

  // 3c. Insert useState + the runtime effect at the top of the component.
  // FIXED: useEffect for backdrop-dismiss + body-scroll-lock (reads data-overlay).
  // RELATIVE: useLayoutEffect that positions the popover from its trigger.
  //
  // IDEMPOTENT — never emit a declaration this body already has. The overlay id
  // embeds the trigger id (`overlay-<triggerId>-<n>`) and `n` comes from a
  // MODULE-scope counter that restarts at 0 on every editor load, so the first
  // overlay of a new session on a trigger that already had one reuses the exact
  // same id. Re-declaring `const [<var>, set<Var>]` in the same scope is a hard
  // SyntaxError; the page then parses to ZERO nodes and the canvas goes blank
  // (live find 2026-07-25: "recreate modal overlay → my page completely
  // crashes"). Probed against `code`, not `result` — `result` already contains
  // the overlay element we just spliced in, whose `data-id` would false-positive
  // the effect probe. A removal that left orphan runtime behind heals the same
  // way: we top up only what's missing.
  {
    const stateAlreadyDeclared = new RegExp(`const\\s*\\[\\s*${escapeRegExp(varName)}\\s*[,\\]]`).test(code);
    const effectAlreadyPresent = code.includes(`}, [${varName}]);`);
    if (stateAlreadyDeclared || effectAlreadyPresent) {
      trace.action('overlay-gen:create:runtime-already-present', {
        overlayId, varName, stateAlreadyDeclared, effectAlreadyPresent,
      });
    }
    const decl = stateAlreadyDeclared ? '' : stateDecl;
    const effect = effectAlreadyPresent
      ? ''
      : (overlayConfig.type === 'fixed'
        ? buildFixedOverlayRuntimeEffect(overlayId)
        : buildRelativeOverlayPosEffect(overlayId));
    if (decl || effect) {
      result = result.slice(0, statePos) + decl + effect + result.slice(statePos);
    }
  }

  trace.action('overlay-gen:create:done', { triggerId, overlayId, type: overlayConfig.type });
  return result;
}

/** Sanitize a copied overlay element's style object for runtime reattach: drop
 *  paste-internal flags + positioner-owned props, then layer the type's base
 *  position styles on top. Fixed (modal) backdrops are config-driven, so the
 *  copied box styles are discarded (the children carry the look). */
function sanitizeOverlayStyles(raw: Record<string, string>, cfg: OverlayConfig): Record<string, string> {
  const base = buildPositionStyles(cfg);
  if (cfg.type === 'fixed') return base;
  const rest = { ...raw };
  delete rest.isAbsoluteInFrame;
  delete rest.isFakeFixed;
  delete rest.position; // forced to 'fixed' by buildPositionStyles (portal-immune)
  delete rest.left;     // owned by the runtime positioner
  delete rest.top;
  return { ...base, ...rest };
}

/**
 * Reattach a PASTED (runtime-target) overlay to its pasted trigger as a real,
 * working overlay. Paste recreates an overlay's element + children as plain nodes —
 * a BARE `<div data-overlay='…'>…children…</div>` with NO `<AnimatePresence>`, NO
 * `useState`, NO positioner effect, an un-remapped `triggerId`, and a stale (or
 * malformed-duplicate) `data-overlay-trigger` on the trigger. This drops the bare
 * element and rebuilds the full machine via `createOverlayInCode` (state + effect +
 * AnimatePresence + handler), reusing the captured styles + children.
 *
 * CANVAS-target paste is handled separately (in `rebuildPastedOverlays`) by repointing
 * both configs via the mutation queue so the static canvas overlay survives the
 * structural-flush heals — it does NOT go through here.
 *
 * No-op if the pasted overlay element can't be found (e.g. the overlay wasn't copied).
 */
export function reattachPastedOverlayInCode(
  code: string,
  newTriggerId: string,
  newOverlayId: string,
  overlayConfig: OverlayConfig,
  triggerConfig: OverlayTriggerConfig,
): string {
  trace.fn('overlay-gen:reattachPasted', { newTriggerId, newOverlayId, type: overlayConfig.type });

  const idIdx = findJSXDataIdIndex(code, newOverlayId);
  if (idIdx < 0) { trace.action('overlay-gen:reattachPasted:overlay-not-found', { newOverlayId }); return code; }
  const tagStart = code.lastIndexOf('<', idIdx);
  const elEnd = findElementEnd(code, tagStart);
  if (tagStart < 0 || elEnd < 0) return code;
  const elementMarkup = code.slice(tagStart, elEnd);
  const rawStyles = readStyleObjectFromTag(elementMarkup);

  // Child JSX between the overlay's opening `>` and its OWN closing tag — computed
  // WITHIN `elementMarkup` (bounded), not against the full `code`. The full-code
  // `lastIndexOf('</', elEnd)` lands on the NEXT element's `</` when the overlay is
  // empty and immediately followed by a sibling/parent close (`…></div></div>`),
  // which captured the overlay's own `</div>` as bogus inner content → invalid JSX.
  const openClose = findTagClose(code, idIdx);
  let inner = '';
  if (openClose > 0 && code[openClose - 1] !== '/') {
    const openCloseRel = openClose - tagStart;
    const closeRel = elementMarkup.lastIndexOf('</');
    if (closeRel > openCloseRel) inner = elementMarkup.slice(openCloseRel + 1, closeRel);
  }

  const ovCfg: OverlayConfig = { ...overlayConfig, triggerId: newTriggerId };
  const trCfg: OverlayTriggerConfig = { ...triggerConfig, targetId: newOverlayId };

  // RUNTIME overlay: drop the bare element, rebuild the full machine around the
  // preserved styles + children.
  const stripped = removeBareOverlayElement(code, newOverlayId);
  const result = createOverlayInCode(stripped, newTriggerId, newOverlayId, ovCfg, trCfg, {
    styles: sanitizeOverlayStyles(rawStyles, ovCfg),
    inner,
  });
  trace.action('overlay-gen:reattachPasted:runtime', { newTriggerId, newOverlayId });
  return result;
}

/**
 * STRIP a pasted overlay outright — remove the overlay element + clear the trigger's
 * `data-overlay-trigger` (and any open/close handler). Used when a FIXED (modal)
 * overlay is pasted INTO a design-component master: components don't resolve fixed
 * overlays (no full-viewport modal inside a variant), so the overlay is dropped and
 * the trigger becomes a plain node. Works for the bare runtime copy AND the canvas
 * (`data-canvas-node`) copy. No state/effect to remove (reattach is skipped for these).
 */
export function stripPastedOverlayInCode(code: string, triggerId: string, overlayId: string): string {
  trace.fn('overlay-gen:stripPastedOverlay', { triggerId, overlayId });
  let result = removeBareOverlayElement(code, overlayId);
  const idIdx = findJSXDataIdIndex(result, triggerId);
  if (idIdx >= 0) {
    const tagStart = result.lastIndexOf('<', idIdx);
    const tagClose = findTagClose(result, idIdx);
    if (tagStart >= 0 && tagClose >= 0) {
      let tag = result.slice(tagStart, tagClose + 1);
      tag = tag.replace(/\s*data-overlay-trigger=('[^']*'|"[^"]*")/g, '');
      // Defensive: drop a stale open/close handler if one came along.
      const setter = `set${stateVarName(overlayId).charAt(0).toUpperCase()}${stateVarName(overlayId).slice(1)}`;
      tag = tag.replace(new RegExp(`\\s*\\w+=\\{\\(\\)\\s*=>\\s*${escapeRegExp(setter)}\\([^}]*\\)\\}`, 'g'), '');
      result = result.slice(0, tagStart) + tag + result.slice(tagClose + 1);
    }
  }
  trace.action('overlay-gen:stripPastedOverlay:done', { triggerId, overlayId });
  return result;
}

/** Read a px number from `key: 'NNNpx'` (or `key: 'NNN'`) in a JSX style object. */
function readPxFromTag(tagText: string, key: string): number {
  // Accept single OR double quotes — `quoteStyleValue` emits single, but a value
  // containing a quote falls back to JSON.stringify (double), so be tolerant.
  const m = tagText.match(new RegExp(`${key}\\s*:\\s*['"]([\\-0-9.]+)px['"]`))
    || tagText.match(new RegExp(`${key}\\s*:\\s*['"]([\\-0-9.]+)['"]`));
  return m ? parseFloat(m[1]) || 0 : 0;
}

/** Initial canvas-space left/top for an overlay relative to its trigger — the
 *  same side/align/offset math as `Renderer.computeOverlayPosition` (scale 1,
 *  collision off). `positionCanvasNodeOverlays` re-derives this every render, so
 *  it only needs to be close enough to avoid a first-frame flash. */
function canvasOverlayInitialPos(
  cfg: OverlayConfig, ow: number, oh: number,
  t: { left: number; top: number; width: number; height: number },
): { left: number; top: number } {
  const g = 8, ox = cfg.offsetX || 0, oy = cfg.offsetY || 0;
  let top: number, left: number;
  switch (cfg.side || 'bottom') {
    case 'top': top = t.top - oh - g + oy; left = t.left + ox; break;
    case 'left': top = t.top + oy; left = t.left - ow - g + ox; break;
    case 'right': top = t.top + oy; left = t.left + t.width + g + ox; break;
    default: top = t.top + t.height + g + oy; left = t.left + ox; break;
  }
  if (cfg.side === 'top' || cfg.side === 'bottom' || !cfg.side) {
    if (cfg.align === 'center') left = t.left + t.width / 2 - ow / 2 + ox;
    else if (cfg.align === 'end') left = t.left + t.width - ow + ox;
  } else {
    if (cfg.align === 'center') top = t.top + t.height / 2 - oh / 2 + oy;
    else if (cfg.align === 'end') top = t.top + t.height - oh + oy;
  }
  return { left, top };
}

/**
 * Create a relative overlay whose trigger is a CANVAS node.
 *
 * A canvas-node trigger lives in the module-scope `canvasNodes` fragment, NOT in
 * the component's return — so the normal `createOverlayInCode` (useState +
 * conditional in the return + onClick on the trigger) would mis-insert and
 * crash. Instead we build the overlay directly in its FINAL canvas form — the
 * same end-state `extractOverlayToCanvasInCode` produces when a viewport
 * trigger is dragged out: a `data-canvas-node` div carrying `data-overlay`,
 * `position: absolute` + a left/top placeholder (re-derived each render by
 * `positionCanvasNodeOverlays`). The trigger keeps only `data-overlay-trigger`
 * (editor pairing) — no onClick, since canvas nodes are never executed.
 */
/** Parse a JSX `style={{ … }}` object out of an element's opening tag into a
 *  flat record (quoted values unwrapped; bare numbers like `zIndex: 50` kept). */
function readStyleObjectFromTag(tagText: string): Record<string, string> {
  const out: Record<string, string> = {};
  const sm = tagText.match(/style=\{\{([\s\S]*?)\}\}/);
  if (!sm) return out;
  const re = /([a-zA-Z][\w-]*)\s*:\s*(?:'([^']*)'|"([^"]*)"|([\d.]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sm[1])) !== null) {
    out[m[1]] = m[2] ?? m[3] ?? m[4] ?? '';
  }
  return out;
}

/** Locate a trigger element (JSX-aware — skips `[data-id="x"]` CSS selectors in
 *  `<style>` blocks) and read its position/size. */
function readTriggerPos(code: string, triggerId: string):
  | { tagStart: number; tagClosePos: number; triggerTag: string; t: { left: number; top: number; width: number; height: number } }
  | null {
  const triggerIdx = findJSXDataIdIndex(code, triggerId);
  if (triggerIdx < 0) return null;
  const tagStart = code.lastIndexOf('<', triggerIdx);
  let depth = 0, tagClosePos = -1;
  for (let i = tagStart; i < code.length; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}') depth--;
    else if (code[i] === '>' && depth === 0) { tagClosePos = i; break; }
  }
  if (tagClosePos < 0) return null;
  const triggerTag = code.slice(tagStart, tagClosePos);
  return {
    tagStart, tagClosePos, triggerTag,
    t: {
      left: readPxFromTag(triggerTag, 'left'),
      top: readPxFromTag(triggerTag, 'top'),
      width: readPxFromTag(triggerTag, 'width'),
      height: readPxFromTag(triggerTag, 'height'),
    },
  };
}

/** Tag `triggerId`'s element with `data-overlay-trigger` (REPLACE any stale one —
 *  a clone trigger inherits the source's, pointing at the wrong overlay) and
 *  append `overlayMarkup` into the canvasNodes fragment (create it if absent). */
function pairTriggerAndAppendOverlay(
  code: string,
  triggerId: string,
  triggerConfig: OverlayTriggerConfig,
  overlayMarkup: string,
): string {
  const tp = readTriggerPos(code, triggerId);
  if (!tp) { trace.error('overlay-gen:pair:trigger-not-found', { triggerId }); return code; }
  let result = code;
  const triggerAttr = ` data-overlay-trigger='${JSON.stringify(triggerConfig)}'`;
  if (/data-overlay-trigger='[^']*'/.test(tp.triggerTag)) {
    const newTag = tp.triggerTag.replace(/\s*data-overlay-trigger='[^']*'/, triggerAttr);
    result = result.slice(0, tp.tagStart) + newTag + result.slice(tp.tagClosePos);
  } else {
    result = result.slice(0, tp.tagClosePos) + triggerAttr + result.slice(tp.tagClosePos);
  }
  const indented = '  ' + overlayMarkup.replace(/\n/g, '\n  ');
  const closeIdx = findCanvasNodesFragmentClose(result);
  if (closeIdx !== -1) {
    result = result.slice(0, closeIdx) + '\n' + indented + '\n' + result.slice(closeIdx);
  } else {
    const exportIdx = findExportDefaultEndIdx(result);
    const block = `\n\nconst canvasNodes = (<>\n${indented}\n</>);\n`;
    result = exportIdx !== -1 ? result.slice(0, exportIdx) + block + result.slice(exportIdx) : result + block;
  }
  return result;
}

/**
 * Build a canvas-node overlay element (look = `cardStyles`, size = ow×oh),
 * tag the trigger with `data-overlay-trigger`, and insert into `canvasNodes`.
 * Shared by create (default look). `cardStyles` must NOT include
 * position/left/top — those are computed from the trigger.
 */
function insertCanvasOverlay(
  code: string,
  triggerId: string,
  overlayId: string,
  overlayConfig: OverlayConfig,
  triggerConfig: OverlayTriggerConfig,
  cardStyles: Record<string, string>,
  ow: number,
  oh: number,
): string {
  const tp = readTriggerPos(code, triggerId);
  if (!tp) { trace.error('overlay-gen:insertCanvasOverlay:trigger-not-found', { triggerId }); return code; }
  const pos = canvasOverlayInitialPos(overlayConfig, ow, oh, tp.t);
  const styles: Record<string, string> = {
    position: 'absolute',
    left: `${Math.round(pos.left)}px`,
    top: `${Math.round(pos.top)}px`,
    ...cardStyles,
  };
  // A `motion.div` carrying the default Appear (initial→animate + exit) as
  // metadata — the SAME shape an extracted viewport overlay has on the canvas
  // (no <AnimatePresence> here — that's editor-only runtime; rehydrate re-adds
  // it when the trigger is dragged into a viewport). So a canvas-created overlay
  // keeps its Appear and animates once dragged in, matching create-in-viewport.
  const markup = `<motion.div key="${overlayId}" data-id="${overlayId}" data-name="Overlay" data-canvas-node="true" data-overlay='${JSON.stringify(overlayConfig)}' initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 20 }} ${formatStyleAttr(styles, '  ')}>\n  </motion.div>`;
  return pairTriggerAndAppendOverlay(code, triggerId, triggerConfig, markup);
}

export function createCanvasOverlayInCode(
  code: string,
  triggerId: string,
  overlayId: string,
  overlayConfig: OverlayConfig,
  triggerConfig: OverlayTriggerConfig,
): string {
  trace.fn('overlay-gen:createCanvas', { triggerId, overlayId });
  const cardStyles: Record<string, string> = {
    width: '200px',
    height: '100px',
    backgroundColor: '#7CBFFF',
    borderRadius: '8px',
    border: '1px solid rgba(255,255,255,0.1)',
    boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
  };
  const result = insertCanvasOverlay(code, triggerId, overlayId, overlayConfig, triggerConfig, cardStyles, 200, 100);
  trace.action('overlay-gen:createCanvas:done', { triggerId, overlayId });
  return result;
}

/**
 * Clone an existing overlay onto a CANVAS-node trigger clone — used when a
 * REPLICA node that owns an overlay is dragged out to the canvas. The replica
 * drag-out CLONES the node (new id) and leaves the original in its viewports;
 * this gives that clone its OWN overlay, the same way the node itself was
 * cloned. The clone is a fresh canvas overlay (new id) paired to `cloneTriggerId`:
 *   - config = the SOURCE overlay's config resolved for `vpWidth` (the replica's
 *     breakpoint), flattened (a single canvas overlay has no responsive cascade);
 *   - the ENTIRE subtree (overlay + all children/contents) is copied, with EVERY
 *     `data-id` re-mapped to a fresh id so the clone's descendants don't collide
 *     with the still-live source overlay's descendants.
 * No-op when the source isn't an overlay trigger, or its overlay is missing.
 */
export function cloneOverlayToCanvasTriggerInCode(
  code: string,
  sourceTriggerId: string,
  cloneTriggerId: string,
  vpWidth: number,
  variant?: string | null,
): string {
  trace.fn('overlay-gen:cloneOverlay', { sourceTriggerId, cloneTriggerId, vpWidth, variant });

  const srcTrig = parseOverlayTriggerCalls(code).find(t => t.triggerId === sourceTriggerId);
  if (!srcTrig?.config.targetId) return code;
  const srcOverlayId = srcTrig.config.targetId;

  // Capture the FULL source overlay subtree (root element + all children).
  const idIdx = findJSXDataIdIndex(code, srcOverlayId);
  if (idIdx < 0) return code;
  const tagStart = code.lastIndexOf('<', idIdx);
  const elementEnd = findElementEnd(code, tagStart);
  if (tagStart < 0 || elementEnd < 0) return code;
  let markup = code.slice(tagStart, elementEnd);

  // Source overlay config → resolved for the replica width, flattened, repointed.
  const rawCfg: OverlayConfig = getJsonAttr<OverlayConfig>(code, srcOverlayId, 'data-overlay')
    ?? ({ type: 'relative', triggerId: cloneTriggerId } as OverlayConfig);
  if (rawCfg.type === 'fixed') return code; // fixed/modal overlays aren't trigger-relative — nothing to clone

  // Resolve the source overlay's config for the dragged-out replica/VARIANT, so
  // the clone inherits the position it had on THAT tile (variant override wins).
  const resolved = resolveOverlayConfig(rawCfg, variant ?? '', vpWidth);
  const newOverlayId = `${cloneTriggerId}-overlay`;
  const cloneCfg: OverlayConfig = {
    type: 'relative',
    triggerId: cloneTriggerId,
    side: resolved.side,
    align: resolved.align,
    offsetX: resolved.offsetX ?? 0,
    offsetY: resolved.offsetY ?? 0,
    ...(resolved.collision ? { collision: resolved.collision } : {}),
    ...(resolved.collisionPadding !== undefined ? { collisionPadding: resolved.collisionPadding } : {}),
  };

  // 1. Re-id EVERY data-id in the subtree so the clone's children don't collide
  //    with the still-live source overlay's children. Root → newOverlayId; each
  //    descendant → `${id}-${cloneTriggerId}` (cloneTriggerId is unique per clone).
  //    Re-id the matching `key="…"` too (AnimatePresence keys) — leaving a stale
  //    key created duplicate React keys that tangled later extract/rehydrate.
  const subtreeIds = Array.from(new Set(Array.from(markup.matchAll(/data-id="([^"]+)"/g), m => m[1])));
  for (const id of subtreeIds) {
    const newId = id === srcOverlayId ? newOverlayId : `${id}-${cloneTriggerId}`;
    markup = markup.split(`data-id="${id}"`).join(`data-id="${newId}"`);
    markup = markup.split(`key="${id}"`).join(`key="${newId}"`);
  }

  // 2. Root transform (same end-state as extractOverlayToCanvasInCode):
  //    data-overlay → cloneCfg, add data-canvas-node, flip the ROOT's position
  //    'fixed' → 'absolute' + computed left/top (children keep their own styles).
  markup = markup.replace(/data-overlay='[^']*'/, `data-overlay='${JSON.stringify(cloneCfg)}'`);
  const rootTagClose = findTagClose(markup, 0);
  if (rootTagClose > 0 && !/data-canvas-node/.test(markup.slice(0, rootTagClose))) {
    const insertAt = markup[rootTagClose - 1] === '/' ? rootTagClose - 1 : rootTagClose;
    markup = markup.slice(0, insertAt) + ' data-canvas-node="true"' + markup.slice(insertAt);
  }
  // Place relative to the clone trigger (same math positionCanvasNodeOverlays
  // re-derives each render). The first `position:` in the markup is the root's.
  const tp = readTriggerPos(code, cloneTriggerId);
  const rootStyles = readStyleObjectFromTag(markup);
  const ow = parseFloat(rootStyles.width || '200') || 200;
  const oh = parseFloat(rootStyles.height || '100') || 100;
  const pos = tp ? canvasOverlayInitialPos(cloneCfg, ow, oh, tp.t) : { left: 0, top: 0 };
  const posDecl = `position: 'absolute', left: '${Math.round(pos.left)}px', top: '${Math.round(pos.top)}px'`;
  if (/position:\s*'fixed'/.test(markup)) {
    markup = markup.replace(/position:\s*'fixed'/, posDecl);
  } else {
    // Canvas-origin overlay (already absolute): replace its position+left/top.
    markup = markup.replace(/position:\s*'absolute'(,\s*left:\s*'-?[0-9.]+px',\s*top:\s*'-?[0-9.]+px')?/, posDecl);
  }

  const cloneTriggerConfig: OverlayTriggerConfig = { ...srcTrig.config, targetId: newOverlayId };
  const result = pairTriggerAndAppendOverlay(code, cloneTriggerId, cloneTriggerConfig, markup);
  trace.action('overlay-gen:cloneOverlay:done', { sourceTriggerId, cloneTriggerId, newOverlayId, children: subtreeIds.length - 1 });
  return result;
}

/**
 * Update overlay position config.
 */
export function updateOverlayPositionInCode(
  code: string,
  overlayId: string,
  config: OverlayConfig,
): string {
  trace.fn('overlay-gen:updatePosition', { overlayId, side: config.side, align: config.align });

  // Update data-overlay attribute
  let result = code.replace(
    new RegExp(`(data-id="${overlayId}"[^>]*data-overlay=')([^']*)(')`),
    `$1${JSON.stringify(config)}$3`
  );

  // Also try reverse order (data-overlay before data-id)
  if (result === code) {
    result = code.replace(
      new RegExp(`(data-overlay=')([^']*)('[^>]*data-id="${overlayId}")`),
      `$1${JSON.stringify(config)}$3`
    );
  }

  // Update position styles
  const posStyles = buildPositionStyles(config);
  // Find the overlay element's style attribute and replace position-related properties
  const overlayIdx = result.indexOf(`data-id="${overlayId}"`);
  if (overlayIdx >= 0) {
    const tagStart = result.lastIndexOf('<', overlayIdx);
    // Find style={{ ... }} on this element
    const afterTag = result.slice(tagStart, tagStart + 3000);
    const styleMatch = afterTag.match(/style=\{\{([\s\S]*?)\}\}/);
    if (styleMatch) {
      // Parse existing styles, replace position-related ones
      const existingStyles = styleMatch[1];
      const posKeys = new Set(['position', 'top', 'bottom', 'left', 'right', 'inset', 'transform', 'zIndex']);
      const keepLines = existingStyles.split(',').filter(line => {
        const key = line.trim().split(':')[0]?.trim().replace(/'/g, '');
        return key && !posKeys.has(key);
      });
      const newPosEntries = Object.entries(posStyles).map(([k, v]) => {
        const camel = k.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
        return `${camel}: ${quoteStyleValue(v)}`;
      });
      const combined = [...newPosEntries, ...keepLines.map(l => l.trim()).filter(Boolean)].join(', ');
      const styleStart = tagStart + afterTag.indexOf(styleMatch[0]);
      result = result.slice(0, styleStart) + `style={{ ${combined} }}` + result.slice(styleStart + styleMatch[0].length);
    }
  }

  trace.action('overlay-gen:updatePosition:done', { overlayId });
  return result;
}

/**
 * Update an overlay's config for a specific viewport (responsive overrides).
 *
 *  - `vpWidth === null` → write the BASE (primary/desktop) config.
 *  - `vpWidth === <number>` → write `config.responsive[vpWidth]` (a replica
 *    override). `resetKeys` removes those keys from the replica override so it
 *    falls back to base (the "reset override" affordance). When a replica
 *    override empties out it's dropped; when `responsive` empties it's dropped.
 *
 * Only rewrites the `data-overlay` JSON — positioning is recomputed at render
 * (canvas) / runtime (live) from the resolved config, so no style rewrite here.
 */
export function updateOverlayConfigInCode(
  code: string,
  overlayId: string,
  patch: OverlayConfigPatch,
  vpWidth: number | null,
  resetKeys: (keyof OverlayConfigPatch)[] = [],
  breakpoints?: number[],
  variant?: string | null,
): string {
  trace.fn('overlay-gen:updateConfig', { overlayId, vpWidth, variant, patchKeys: Object.keys(patch), resetKeys });

  const esc = escapeRegExp(overlayId);
  // data-id before data-overlay (the order createOverlay emits).
  let order: 'id-first' | 'overlay-first' = 'id-first';
  let m = new RegExp(`(data-id="${esc}"[^>]*data-overlay=')([^']*)(')`).exec(code);
  if (!m) {
    order = 'overlay-first';
    m = new RegExp(`(data-overlay=')([^']*)('[^>]*data-id="${esc}")`).exec(code);
  }
  if (!m) { trace.error('overlay-gen:updateConfig:not-found', { overlayId }); return code; }

  let config: OverlayConfig;
  try { config = JSON.parse(m[2]); } catch { return code; }

  if (variant) {
    // Design-component VARIANT override — keyed by variant name (exact, no
    // breakpoint cascade), the variant=replica analog of the width path below.
    const rv: Record<string, OverlayConfigOverride> = { ...(config.responsiveVariant || {}) };
    const cur: OverlayConfigOverride = { ...(rv[variant] || {}) };
    Object.assign(cur, patch);
    for (const k of resetKeys) delete (cur as Record<string, unknown>)[k];
    if (Object.keys(cur).length === 0) delete rv[variant];
    else rv[variant] = cur;
    if (Object.keys(rv).length === 0) delete config.responsiveVariant;
    else config.responsiveVariant = rv;
  } else if (vpWidth == null) {
    config = { ...config, ...patch };
    for (const k of resetKeys) delete (config as Partial<OverlayConfig>)[k];
  } else {
    const key = String(vpWidth);
    const responsive: Record<string, OverlayConfigOverride> = { ...(config.responsive || {}) };
    const cur: OverlayConfigOverride = { ...(responsive[key] || {}) };
    Object.assign(cur, patch);
    for (const k of resetKeys) delete (cur as Record<string, unknown>)[k];
    if (Object.keys(cur).length === 0) delete responsive[key];
    else responsive[key] = cur;
    if (Object.keys(responsive).length === 0) {
      delete config.responsive;
      delete config.responsiveBp; // no overrides left → drop the breakpoint list too
    } else {
      config.responsive = responsive;
      // Refresh the owning-viewport breakpoint list so resolution maps each
      // width to the right viewport (a no-override viewport → base, never a
      // larger replica). Sorted ascending; deduped.
      if (breakpoints && breakpoints.length) {
        config.responsiveBp = Array.from(new Set(breakpoints.filter(Number.isFinite))).sort((a, b) => a - b);
      }
    }
  }

  const newJson = JSON.stringify(config);
  const replacement = order === 'id-first'
    ? m[1] + newJson + m[3]
    : m[1] + newJson + m[3];
  let result = code.slice(0, m.index) + replacement + code.slice(m.index + m[0].length);

  // FIXED overlay appear TRANSITION edits are framer-motion props (can't be applied
  // via DOM at runtime), so they must be REWRITTEN into the motion.div JSX so the
  // published page reflects the change — `transition={…}` (enter) + the nested
  // `transition` inside `exit={{…}}`.
  if (config.type === 'fixed' && (patch.enterTransition || patch.exitTransition)) {
    result = rewriteFixedOverlayTransition(result, overlayId, config);
  }

  // Component-instance "On Open: Set Variant" — drive the instance trigger's
  // `initialVariant` from the overlay open state so the instance switches variant
  // while open and reverts on close. (A simple master renders
  // `animate={['default', initialVariant]}`, so a changing initialVariant prop
  // switches it live.)
  //
  // The instance ternary is rewritten from the FULL config (base + per-REPLICA
  // `responsive` overrides) on base and width writes — the open-state expression
  // resolves the right variant by viewport width at render time. A design-component
  // VARIANT write (responsiveVariant) is a different axis (the master's own
  // variant, not window width), so it's stored in config only — not baked here.
  const touchesOnOpen = patch.onOpenVariant !== undefined || resetKeys.includes('onOpenVariant');
  if (touchesOnOpen && config.triggerId && !variant) {
    result = applyOverlayOpenVariantInCode(result, overlayId, config);
  }

  trace.action('overlay-gen:updateConfig:done', { overlayId, vpWidth });
  return result;
}

/** Build the OPEN-state variant expression for an instance trigger. When the
 *  overlay has per-page-REPLICA `responsive` overrides for `onOpenVariant`, the
 *  expression resolves the right variant by `window.innerWidth` — the SAME
 *  owning-breakpoint logic the positioning effect uses (`ww <= bp`, smallest bp
 *  ≥ width). No inner `{}` (regex-safe) and `window.innerWidth` is only read when
 *  open (always client-side), so no SSR guard is needed. Returns a quoted string
 *  for the static case or a parenthesised nested ternary for the responsive one. */
function buildOnOpenVariantExpr(config: OverlayConfig): string {
  const baseOpen = config.onOpenVariant || '';
  if (!baseOpen) return '';
  const responsive = config.responsive || {};
  const bps = (config.responsiveBp || []).slice().sort((a, b) => a - b);
  const overrideBps = bps.filter(bp => responsive[String(bp)]?.onOpenVariant !== undefined);
  if (overrideBps.length === 0) return `'${baseOpen}'`;

  // Boundaries down to the largest override bp — smaller widths route to their
  // own (no-override → base) branch; wider widths fall through to `baseOpen`.
  const maxOv = Math.max(...overrideBps);
  const boundaryBps = bps.filter(bp => bp <= maxOv);
  let expr = `'${baseOpen}'`;
  for (let i = boundaryBps.length - 1; i >= 0; i--) {
    const bp = boundaryBps[i];
    const v = responsive[String(bp)]?.onOpenVariant ?? baseOpen;
    expr = `window.innerWidth <= ${bp} ? '${v}' : ${expr}`;
  }
  return `(${expr})`;
}

/** Drive a component-instance trigger's `initialVariant` from the overlay's open
 *  state: `initialVariant={<id>Open ? <openExpr> : '<closed>'}` (switch while
 *  open, revert to the closed variant on close). `<openExpr>` is responsive by
 *  viewport width (see buildOnOpenVariantExpr). When there's no `onOpenVariant`,
 *  restore the static closed variant. `<closed>` is recovered from the current
 *  static value or the prior ternary's else-branch (default 'default'). */
function applyOverlayOpenVariantInCode(code: string, overlayId: string, config: OverlayConfig): string {
  const triggerId = config.triggerId;
  if (!triggerId) return code;
  const tIdx = findJSXDataIdIndex(code, triggerId);
  if (tIdx < 0) return code;
  const tagStart = code.lastIndexOf('<', tIdx);
  const tagClose = findTagClose(code, tagStart);
  if (tagStart < 0 || tagClose < 0) return code;
  let tag = code.slice(tagStart, tagClose);
  const varName = stateVarName(overlayId);

  // Recover the CLOSED (revert) variant from the existing initialVariant — the
  // final `'…'` before the closing brace (works for both the simple ternary and
  // the responsive nested form), or a bare static value.
  let closed = 'default';
  const ivMatch = tag.match(/\s*initialVariant=("[^"]*"|\{[^}]*\})/);
  if (ivMatch) {
    const val = ivMatch[1];
    const staticM = val.match(/^"([^"]*)"$/);
    if (staticM) closed = staticM[1];
    else {
      const elseM = val.match(/:\s*'([^']*)'\s*\}$/); // {…Open ? <expr> : 'B'} → B
      if (elseM) closed = elseM[1];
    }
  }

  const openExpr = buildOnOpenVariantExpr(config);
  const newIv = openExpr
    ? ` initialVariant={${varName} ? ${openExpr} : '${closed}'}`
    : ` initialVariant="${closed}"`;
  tag = ivMatch
    ? tag.replace(/\s*initialVariant=("[^"]*"|\{[^}]*\})/, newIv)
    : appendAttrsToOpeningTag(tag, newIv);

  trace.action('overlay-gen:onOpenVariant', { triggerId, overlayId, openExpr, closed });
  return code.slice(0, tagStart) + tag + code.slice(tagClose);
}

/** Replace a JSX prop's BALANCED `{…}` value on a single tag. `newValue` is the
 *  literal that follows `propName=` (include the braces). No-op if absent. */
function replaceBalancedProp(tag: string, propName: string, newValue: string): string {
  const re = new RegExp(`\\b${propName}=\\{`);
  const mm = re.exec(tag);
  if (!mm) return tag;
  const braceStart = mm.index + mm[0].length - 1; // at the first '{'
  let depth = 0, i = braceStart;
  for (; i < tag.length; i++) {
    if (tag[i] === '{') depth++;
    else if (tag[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return tag.slice(0, mm.index) + `${propName}=${newValue}` + tag.slice(i);
}

/** Rewrite a fixed overlay's enter `transition={…}` + `exit={{…}}` props from its
 *  (already-updated) config. */
function rewriteFixedOverlayTransition(code: string, overlayId: string, config: OverlayConfig): string {
  const idIdx = findJSXDataIdIndex(code, overlayId);
  if (idIdx < 0) return code;
  const tagStart = code.lastIndexOf('<', idIdx);
  const tagClose = findTagClose(code, tagStart);
  if (tagStart < 0 || tagClose < 0) return code;
  let tag = code.slice(tagStart, tagClose);
  const enterT = formatTransitionJSX(config.enterTransition ?? DEFAULT_ENTER_TRANSITION);
  const exitT = formatTransitionJSX(config.exitTransition ?? DEFAULT_EXIT_TRANSITION);
  // enter: top-level `transition={…}`. exit: whole `exit={{ opacity: 0, transition: … }}`.
  tag = replaceBalancedProp(tag, 'transition', `{${enterT}}`);
  tag = replaceBalancedProp(tag, 'exit', `{{ opacity: 0, transition: ${exitT} }}`);
  return code.slice(0, tagStart) + tag + code.slice(tagClose);
}

/**
 * Update trigger config (trigger type, dismiss type).
 */
export function updateOverlayTriggerInCode(
  code: string,
  triggerId: string,
  config: OverlayTriggerConfig,
): string {
  trace.fn('overlay-gen:updateTrigger', { triggerId, trigger: config.trigger });

  // Scope to the SPECIFIC trigger element (JSX-aware) — a whole-file regex hits
  // the FIRST `data-overlay-trigger` (wrong one on a multi-overlay page) and a
  // CSS `[data-id]` selector in any `<style>` block.
  const tIdx = findJSXDataIdIndex(code, triggerId);
  if (tIdx < 0) { trace.error('overlay-gen:updateTrigger:not-found', { triggerId }); return code; }
  const tagStart = code.lastIndexOf('<', tIdx);
  const tagClose = findTagClose(code, tagStart);
  if (tagStart < 0 || tagClose < 0) return code;
  let tag = code.slice(tagStart, tagClose); // opening tag, sans the '>'

  // 1. Update (or add) the data-overlay-trigger config attribute.
  const trigAttr = `data-overlay-trigger='${JSON.stringify(config)}'`;
  tag = /data-overlay-trigger='[^']*'/.test(tag)
    ? tag.replace(/data-overlay-trigger='[^']*'/, trigAttr)
    : `${tag} ${trigAttr}`;

  // 2. Swap the RUNTIME HANDLER so the live site actually uses the new trigger:
  //    click → onClick toggle, hover → onMouseEnter/Leave. Without this only the
  //    metadata changed and the page kept the old onClick. Strip whichever
  //    handlers exist for THIS overlay's setter, then add the new one — but ONLY
  //    when the overlay has runtime (a viewport overlay with a useState). A CANVAS
  //    overlay has no runtime; its config attr still updates so rehydration (drag
  //    back into a viewport) emits the right handler.
  const overlayId = config.targetId;
  const varName = stateVarName(overlayId);
  const setter = `set${varName.charAt(0).toUpperCase() + varName.slice(1)}`;
  const esc = escapeRegExp(varName);
  const hasRuntime = new RegExp(`const\\s*\\[${esc},`).test(code);
  tag = stripOverlayHandlers(tag, setter);
  if (hasRuntime) {
    tag = appendAttrsToOpeningTag(tag, buildOverlayHandlerAttr(config, overlayId));
  }

  let result = code.slice(0, tagStart) + tag + code.slice(tagClose);

  // Keep the overlay's HOVER MIRROR handler in sync with the trigger type: a
  // hover trigger needs `onMouseEnter/Leave` on the OVERLAY too (the bridge — so
  // a fixed modal covering its trigger doesn't flicker shut); switching back to
  // click must remove it. Edit the overlay element's opening tag.
  if (hasRuntime) {
    const ovIdx = findJSXDataIdIndex(result, overlayId);
    if (ovIdx >= 0) {
      const ovTagStart = result.lastIndexOf('<', ovIdx);
      const ovTagClose = findTagClose(result, ovTagStart);
      if (ovTagStart >= 0 && ovTagClose >= 0) {
        let ovTag = stripOverlayHandlers(result.slice(ovTagStart, ovTagClose), setter);
        ovTag = `${ovTag}${buildOverlayHoverMirrorAttr(config, overlayId, triggerId)}`;
        result = result.slice(0, ovTagStart) + ovTag + result.slice(ovTagClose);
      }
    }
  }

  trace.action('overlay-gen:updateTrigger:done', { triggerId, trigger: config.trigger });
  return result;
}

/**
 * Remove an overlay and its trigger config.
 */
/** Remove a single overlay's runtime effect by its UNIQUE dependency array
 *  `, [<var>]);`, walking back to the owning `use(Layout)?Effect(`. Scoped to ONE
 *  effect so deleting overlay X can never swallow overlay Y's effect. */
function removeOverlayEffectBlock(code: string, varName: string): string {
  const dep = `, [${varName}]);`;
  const depIdx = code.indexOf(dep);
  if (depIdx < 0) return code;
  const before = code.slice(0, depIdx);
  // 'useLayoutEffect(' is NOT a substring of 'useEffect(' search and vice-versa,
  // so the nearest of either before the dep is this effect's opener.
  const start = Math.max(before.lastIndexOf('useLayoutEffect('), before.lastIndexOf('useEffect('));
  if (start < 0) return code;
  let s = start;
  while (s > 0 && /[ \t]/.test(code[s - 1])) s--;   // trim leading indent
  if (s > 0 && code[s - 1] === '\n') s--;            // and the newline before it
  let e = depIdx + dep.length;
  if (code[e] === '\n') e++;                          // trailing newline
  trace.action('overlay-gen:remove-effect-block', { varName, start: s, end: e });
  return code.slice(0, s) + code.slice(e);
}

export function removeOverlayInCode(code: string, overlayId: string, triggerId: string): string {
  trace.fn('overlay-gen:remove', { overlayId, triggerId });

  const varName = stateVarName(overlayId);
  const esc = escapeRegExp(varName);
  let result = code;

  // 1. Remove the conditional overlay block `{varName && (...)}` (robust to
  //    paren/no-paren + motion.* forms; locates the element, not by regex).
  result = removeOverlayConditionalBlock(result, overlayId, varName);

  // 1b. Self-heal: drop any EMPTY leftover wrapper `{varName && ( )}` / `{varName && }`.
  //     Covers the half-deleted case where a prior plain `removeNode` stripped
  //     the element but left the conditional behind (the `Unexpected token`
  //     parse error). The inner `\s*` only spans whitespace, so a wrapper that
  //     still contains an element never matches.
  result = result.replace(
    new RegExp(`\\n?[^\\S\\n]*\\{${esc}\\s*&&\\s*\\(?\\s*\\)?\\s*\\}`, 'g'),
    '',
  );

  // 2. Remove useState declaration
  const statePattern = new RegExp(`\\s*const\\s*\\[${esc},\\s*\\w+\\]\\s*=\\s*useState\\(false\\);?\\n?`);
  result = result.replace(statePattern, '\n');

  // 2b. Remove THIS overlay's runtime effect — relative `useLayoutEffect`
  //     (positioner) OR fixed `useEffect` (backdrop-dismiss + body-lock). Located
  //     by its UNIQUE dependency array `, [<var>]);` and walked back to the owning
  //     `use(Layout)?Effect(`. (A regex anchored on `useEffect(() => {…[data-id=X]`
  //     started at the FIRST effect in the file and `[\s\S]*?` swallowed EVERY
  //     preceding overlay's effect up to X — the "other overlays open at 0,0 after
  //     deleting one overlay" corruption.)
  result = removeOverlayEffectBlock(result, varName);

  // 3. Remove this trigger's `data-overlay-trigger` attribute — scoped to the
  //    trigger element so a multi-overlay page doesn't lose a SIBLING overlay's
  //    trigger attr (the old unscoped replace stripped the first match in file).
  const tIdx = findJSXDataIdIndex(result, triggerId);
  if (tIdx >= 0) {
    const tClose = findTagClose(result, tIdx);
    if (tClose > tIdx) {
      const tagSlice = result.slice(tIdx, tClose);
      const cleaned = tagSlice.replace(/\s*data-overlay-trigger='[^']*'/, '');
      if (cleaned !== tagSlice) result = result.slice(0, tIdx) + cleaned + result.slice(tClose);
    }
  }
  // Remove handlers for THIS overlay's setter (var name is unique per overlay) —
  // balanced strip so the hover-bridge form is removed too, not just the simple one.
  const setterName = `set${varName.charAt(0).toUpperCase() + varName.slice(1)}`;
  result = stripOverlayHandlers(result, setterName);

  // Component-instance "On Open: Set Variant" teardown — if the trigger drove its
  // `initialVariant` from THIS overlay's open state, revert it to the static closed
  // variant. Without this the removed `useState` leaves `initialVariant={<var>Open
  // ? … : 'base'}` referencing an undefined identifier → validation BLOCKS the
  // removal ("References undefined identifier … would crash at runtime").
  result = revertOverlayOpenVariantInCode(result, triggerId, varName);

  trace.action('overlay-gen:remove:done', { overlayId, triggerId });
  return result;
}

/** Revert a trigger's `initialVariant={<varName> ? '…' : 'closed'}` (the On-Open
 *  variant ternary, base OR the responsive window.innerWidth form) back to the
 *  static closed variant when its overlay is removed. Only touches an
 *  `initialVariant={…}` expression that references `varName` (so a static
 *  `initialVariant="variant-2"` the user set, or another overlay's, is left alone).
 *  No-op when the trigger has no such ternary. */
function revertOverlayOpenVariantInCode(code: string, triggerId: string, varName: string): string {
  const tIdx = findJSXDataIdIndex(code, triggerId);
  if (tIdx < 0) return code;
  const tagStart = code.lastIndexOf('<', tIdx);
  const tagClose = findTagClose(code, tIdx);
  if (tagStart < 0 || tagClose < 0) return code;
  const tag = code.slice(tagStart, tagClose);
  const ivMatch = tag.match(/\s*initialVariant=(\{[^}]*\})/);
  if (!ivMatch || !ivMatch[1].includes(varName)) return code; // not this overlay's ternary
  const closedM = ivMatch[1].match(/:\s*'([^']*)'\s*\}$/); // final else-branch literal
  const closed = closedM ? closedM[1] : 'default';
  const newTag = tag.replace(/\s*initialVariant=\{[^}]*\}/, ` initialVariant="${closed}"`);
  trace.action('overlay-gen:revert-on-open-variant', { triggerId, varName, closed });
  return code.slice(0, tagStart) + newTag + code.slice(tagClose);
}

/** MAKE COMPONENT — root-trigger transfer. When the node being made into a
 *  component IS an overlay TRIGGER, the overlay belongs to the PAGE (attached to
 *  the new INSTANCE), NOT baked into the master. The overlay element + useState +
 *  effect were page-level already (siblings of the root inside the page root), so
 *  they stay put — only the `data-overlay-trigger` attr + open handler move OFF the
 *  master root and ONTO the page instance tag (where `{...rest}` forwards them to
 *  the rendered root, so the overlay opens & positions against the instance).
 *  Relative AND fixed root triggers are handled identically here (only the trigger
 *  attr/handler move; a fixed modal's element/state/effect likewise stay on page).
 *
 *  Returns the updated master + instance-page code (unchanged if root isn't a trigger). */
export function transferRootOverlayToInstanceInCode(
  componentCode: string,
  instancePageCode: string,
  originalPageCode: string,
  rootId: string,
): { componentCode: string; instancePageCode: string; moved: boolean } {
  const trig = parseOverlayTriggerCalls(originalPageCode).find(t => t.triggerId === rootId);
  if (!trig) return { componentCode, instancePageCode, moved: false };
  const overlayId = trig.config.targetId;
  const varName = stateVarName(overlayId);
  const setterName = `set${varName.charAt(0).toUpperCase() + varName.slice(1)}`;

  // 1. MASTER: strip the root's `data-overlay-trigger` attr + open handler (it
  //    references a `set…Open` that lives on the PAGE — broken in the master).
  let cc = componentCode;
  const mIdx = findJSXDataIdIndex(cc, rootId);
  if (mIdx >= 0) {
    const tagStart = cc.lastIndexOf('<', mIdx);
    const tagClose = findTagClose(cc, mIdx);
    if (tagStart >= 0 && tagClose >= 0) {
      const tag = cc.slice(tagStart, tagClose).replace(/\s*data-overlay-trigger='[^']*'/, '');
      cc = cc.slice(0, tagStart) + tag + cc.slice(tagClose);
    }
  }
  cc = stripOverlayHandlers(cc, setterName); // balanced strip (click + hover-bridge forms)

  // 2. INSTANCE: re-arm the trigger attr + handler on the instance tag — the
  //    instance is now the trigger; `{...rest}` in the master forwards them.
  let pc = instancePageCode;
  const iIdx = findJSXDataIdIndex(pc, rootId);
  if (iIdx >= 0) {
    const tagClose = findTagClose(pc, iIdx);
    if (tagClose >= 0) {
      const attrPos = attrInsertPosBeforeClose(pc, tagClose);
      const attrs = ` data-overlay-trigger='${JSON.stringify(trig.config)}'` + buildOverlayHandlerAttr(trig.config, overlayId);
      pc = pc.slice(0, attrPos) + attrs + pc.slice(attrPos);
    }
  }
  trace.action('overlay-gen:make-component-root-transfer', { rootId, overlayId, type: trig.config });
  return { componentCode: cc, instancePageCode: pc, moved: true };
}

/** MAKE COMPONENT — descendant-trigger transfer. When a CHILD of the extracted node
 *  is an overlay TRIGGER, the overlay belongs INSIDE the master (the trigger child
 *  is now there). The overlay ELEMENT may already be in the master (it was nested in
 *  the parent → extracted) or still on the page (it was a page-root sibling); its
 *  `useState` + effect are ALWAYS page-body, so they're never extracted. This:
 *   - PAGE: `removeOverlayInCode` to strip the orphaned state/effect/element/attr;
 *   - MASTER: ensures the overlay element is present (extracts the page block + inserts
 *     it after the child if missing), re-arms the trigger attr + handler on the child,
 *     and adds the `useState` + positioner/fixed effect to the master body.
 *  Relative → `buildRelativeOverlayPosEffect`; fixed → `buildFixedOverlayRuntimeEffect`.
 *  The caller should run `syncImports` on the master afterward (the extracted
 *  AnimatePresence carries a duplicate framer-motion import to merge). */
export function transferDescendantOverlaysToMasterInCode(
  componentCode: string,
  instancePageCode: string,
  originalPageCode: string,
  rootId: string,
  extractedSubtreeJSX: string,
): { componentCode: string; instancePageCode: string; moved: boolean } {
  const triggers = parseOverlayTriggerCalls(originalPageCode);
  const overlays = parseOverlayCalls(originalPageCode);
  // Descendant = a trigger whose element is in the extracted subtree but ISN'T the
  // extracted root (the root is handled by transferRootOverlayToInstanceInCode).
  const descendants = triggers.filter(t =>
    t.triggerId !== rootId && extractedSubtreeJSX.includes(`data-id="${t.triggerId}"`));
  if (descendants.length === 0) return { componentCode, instancePageCode, moved: false };

  let cc = componentCode;
  let pc = instancePageCode;
  let moved = false;
  for (const t of descendants) {
    const overlayId = t.config.targetId;
    const ov = overlays.find(o => o.overlayId === overlayId);
    if (!ov) continue;
    const varName = stateVarName(overlayId);
    const setVarName = `set${varName.charAt(0).toUpperCase() + varName.slice(1)}`;

    // MASTER: ensure the overlay element is present. Three cases:
    //  A) extraction CARRIED it (it was nested in the parent) → already in `cc`.
    //  B) it was a page-root RUNTIME sibling → move the `{var && (…)}` block in after
    //     the child (preserves its styles/content).
    if (findJSXDataIdIndex(cc, overlayId) < 0) {
      const span = findOverlayBlockSpan(originalPageCode, overlayId, varName);
      if (span) {
        const block = originalPageCode.slice(span.start, span.end);
        const childIdx = findJSXDataIdIndex(cc, t.triggerId);
        if (childIdx >= 0) {
          const childEnd = findElementEnd(cc, cc.lastIndexOf('<', childIdx));
          if (childEnd >= 0) cc = cc.slice(0, childEnd) + '\n      ' + block + cc.slice(childEnd);
        }
      }
    }

    if (findJSXDataIdIndex(cc, overlayId) < 0) {
      //  C) STILL missing → it was a STATIC canvas overlay (in `canvasNodes`, no
      //     conditional/state/effect, not nested in the parent). Build a fresh RUNTIME
      //     overlay on the child in the master — `createOverlayInCode` wires the
      //     useState + effect + element + handler + trigger attr from the config.
      cc = createOverlayInCode(cc, t.triggerId, overlayId, ov.config, t.config);
    } else {
      // Element present (A or B) — ensure the child carries the trigger attr + handler
      // (extraction keeps the attr; the open handler is sometimes dropped), then add the
      // useState + runtime effect (page-body hooks were never extracted).
      const tIdx = findJSXDataIdIndex(cc, t.triggerId);
      if (tIdx >= 0) {
        const tagClose = findTagClose(cc, tIdx);
        const tagStart = cc.lastIndexOf('<', tIdx);
        if (tagClose >= 0 && tagStart >= 0) {
          const tagText = cc.slice(tagStart, tagClose);
          if (!tagText.includes(setVarName)) {
            const attrs = (/data-overlay-trigger=/.test(tagText) ? '' : ` data-overlay-trigger='${JSON.stringify(t.config)}'`)
              + buildOverlayHandlerAttr(t.config, overlayId);
            const attrPos = attrInsertPosBeforeClose(cc, tagClose);
            cc = cc.slice(0, attrPos) + attrs + cc.slice(attrPos);
          }
        }
      }
      if (!cc.includes(`const [${varName},`)) {
        const statePos = findStateInsertPos(cc);
        if (statePos >= 0) {
          const stateDecl = `  const [${varName}, ${setVarName}] = useState(false);\n`;
          const effect = ov.config.type === 'fixed'
            ? buildFixedOverlayRuntimeEffect(overlayId)
            : buildRelativeOverlayPosEffect(overlayId);
          cc = cc.slice(0, statePos) + stateDecl + effect + cc.slice(statePos);
        }
      }
    }

    // PAGE: strip the orphaned runtime overlay (state + effect + conditional). A static
    // CANVAS overlay isn't a conditional, so removeOverlayInCode leaves its bare element
    // behind — remove that too (its trigger left with the extraction → it's an orphan).
    pc = removeOverlayInCode(pc, overlayId, t.triggerId);
    if (findJSXDataIdIndex(pc, overlayId) >= 0) pc = removeBareOverlayElement(pc, overlayId);

    moved = true;
    trace.action('overlay-gen:make-component-descendant-transfer', { rootId, triggerId: t.triggerId, overlayId });
  }
  return { componentCode: cc, instancePageCode: pc, moved };
}

/** Re-generate any MISSING runtime effect for a return overlay that still has its
 *  `useState` + open conditional. A relative overlay with no positioner renders
 *  `position:fixed` at 0,0 (top-left) on the live page; a fixed overlay with no
 *  runtime effect loses backdrop-dismiss / scroll-lock. This self-heals files that
 *  lost effects to the old over-greedy `removeOverlayInCode` regex, and is a no-op
 *  once every overlay has its effect (keyed by the unique `, [<var>]);` dep). */
export function healMissingOverlayEffectsInCode(code: string): string {
  const overlays = parseOverlayCalls(code);
  if (overlays.length === 0) return code;
  let result = code;
  for (const ov of overlays) {
    const varName = stateVarName(ov.overlayId);
    // Only RETURN overlays carry runtime (useState). Canvas overlays are static.
    if (!result.includes(`const [${varName},`)) continue;
    // Effect already present? (dependency array is unique per overlay.)
    if (result.includes(`, [${varName}]);`)) continue;
    // Insert the regenerated effect right after this overlay's useState line.
    const stateRe = new RegExp(`const \\[${escapeRegExp(varName)},\\s*set\\w+\\] = useState\\(false\\);\\n`);
    const m = stateRe.exec(result);
    if (!m) continue;
    const pos = m.index + m[0].length;
    const effect = ov.config.type === 'fixed'
      ? buildFixedOverlayRuntimeEffect(ov.overlayId)
      : buildRelativeOverlayPosEffect(ov.overlayId);
    result = result.slice(0, pos) + effect + result.slice(pos);
    trace.action('overlay-gen:heal-missing-effect', { overlayId: ov.overlayId, type: ov.config.type });
  }
  return result;
}

/** Static transform motion props mirrored from an overlay's `style` into its
 *  framer-motion appear states. TRANSLATE (x/y/z) is EXCLUDED — `y` IS the
 *  appear slide, and overlay position is `left`/`top`, never transform-translate. */
const OVERLAY_APPEAR_TRANSFORM_KEYS = ['rotate', 'rotateX', 'rotateY', 'rotateZ', 'scale', 'scaleX', 'scaleY', 'skewX', 'skewY'];

/** Parse the `key: value` entries of a flat `attr={{ … }}` object (no nested
 *  braces — true of the overlay `style` and its appear objects). Returns the
 *  entry list + the match span so the caller can rewrite in place. */
function readFlatBraceObject(tag: string, attr: string): { kv: [string, string][]; matchStart: number; matchLen: number; openLen: number; closeLen: number } | null {
  const re = new RegExp(`${attr}=\\{\\{([^{}]*)\\}\\}`);
  const m = re.exec(tag);
  if (!m) return null;
  const kv: [string, string][] = [];
  for (const part of splitStyleProps(m[1])) {
    const seg = part.trim().replace(/,$/, '');
    if (!seg) continue;
    const ci = seg.indexOf(':');
    if (ci < 0) continue;
    kv.push([seg.slice(0, ci).trim(), seg.slice(ci + 1).trim()]);
  }
  // openLen = `${attr}={{`, closeLen = `}}`
  return { kv, matchStart: m.index, matchLen: m[0].length, openLen: m[0].length - m[1].length - 2, closeLen: 2 };
}

/** Mirror a relative overlay's STATIC transforms (rotate/scale/skew) from its
 *  inline `style` into its framer-motion `initial`/`animate`/`exit` objects, so
 *  they PERSIST through the enter/exit animation instead of being reset.
 *
 *  WHY: overlays are `motion.div`s whose appear is hardcoded `{ opacity, y }`.
 *  A rotate from the transform control lands in `style` as a motion prop
 *  (`rotate: '142.5'`), which the canvas renders (foldMotionTransforms) — but
 *  framer-motion composes its transform from the tracked initial/animate values,
 *  so a `rotate` absent from those is dropped on the live page. Baking the same
 *  CONSTANT rotate/scale/skew into all three states keeps it fixed while opacity/y
 *  animate. Run after every transform write on an overlay (idempotent). */
export function syncOverlayAppearTransformInCode(code: string, overlayId: string): string {
  const idIdx = findJSXDataIdIndex(code, overlayId);
  if (idIdx < 0) return code;
  const tagStart = code.lastIndexOf('<', idIdx);
  const tagEnd = findTagClose(code, idIdx);
  if (tagStart < 0 || tagEnd < 0) return code;
  let tag = code.slice(tagStart, tagEnd);
  // Scope to overlays that have a real appear (relative overlays). Fixed overlays
  // never show the transform UI; plain motion nodes manage transforms elsewhere.
  if (!tag.includes('data-overlay=') || !/\b(?:initial|animate)=\{\{/.test(tag)) return code;

  // Current static transforms, read from STYLE (the source of truth the canvas uses).
  const styleObj = readFlatBraceObject(tag, 'style');
  const transforms: [string, string][] = (styleObj?.kv || [])
    .filter(([k]) => OVERLAY_APPEAR_TRANSFORM_KEYS.includes(k))
    .map(([k, v]) => [k, v.replace(/^'|'$/g, '')]); // unquote '142.5' → 142.5 (motion reads bare degrees)

  for (const prop of ['initial', 'animate', 'exit']) {
    const obj = readFlatBraceObject(tag, prop);
    if (!obj) continue;
    // Keep non-transform keys (opacity / y / transition), drop stale transform keys,
    // then append the current ones (unitless — motion treats bare rotate as deg).
    const kept = obj.kv.filter(([k]) => !OVERLAY_APPEAR_TRANSFORM_KEYS.includes(k));
    const merged = [...kept, ...transforms].map(([k, v]) => `${k}: ${v}`).join(', ');
    const open = tag.slice(obj.matchStart, obj.matchStart + obj.openLen);
    const replacement = merged ? `${open} ${merged} }}` : `${open} }}`;
    tag = tag.slice(0, obj.matchStart) + replacement + tag.slice(obj.matchStart + obj.matchLen);
  }

  trace.action('overlay-gen:sync-appear-transform', { overlayId, transforms: transforms.map(([k]) => k) });
  return code.slice(0, tagStart) + tag + code.slice(tagEnd);
}

/** NO OVERLAYS INSIDE OVERLAYS. When a node is dragged into an overlay's subtree
 *  (fixed or relative), any overlay it carries — itself a trigger, an overlay
 *  node, or any of its descendants being one — would become a nested overlay,
 *  which is illegal. This heal finds every trigger/overlay element whose position
 *  falls INSIDE another overlay's element span and removes that overlay entirely
 *  (`removeOverlayInCode`). Orphaned overlay NODES left behind (e.g. a canvas
 *  overlay whose trigger attr we just stripped) are swept by the
 *  `pruneOverlayDuplicatesInCode` heal that runs right after this one.
 *
 *  Idempotent: once nothing is nested, it's a no-op. */
export function stripOverlaysNestedInOverlaysInCode(code: string): string {
  const overlays = parseOverlayCalls(code);
  if (overlays.length === 0) return code;
  const triggers = parseOverlayTriggerCalls(code);

  // Element span [start, end] of each overlay container (open tag '<' → element end).
  const spans: { overlayId: string; start: number; end: number }[] = [];
  for (const ov of overlays) {
    const idIdx = findJSXDataIdIndex(code, ov.overlayId);
    if (idIdx < 0) continue;
    const tagStart = code.lastIndexOf('<', idIdx);
    const end = findElementEnd(code, tagStart);
    if (tagStart < 0 || end < 0) continue;
    spans.push({ overlayId: ov.overlayId, start: tagStart, end });
  }
  if (spans.length === 0) return code;

  // Is `pos` strictly inside SOME overlay's span (excluding `selfId`'s own)?
  const insideAnyOverlay = (pos: number, selfId?: string): boolean =>
    spans.some(s => s.overlayId !== selfId && pos > s.start && pos < s.end);

  const toRemove: { overlayId: string; triggerId: string }[] = [];
  // Nested TRIGGERS: a trigger element that now sits inside an overlay subtree.
  for (const t of triggers) {
    const pos = findJSXDataIdIndex(code, t.triggerId);
    if (pos >= 0 && insideAnyOverlay(pos)) {
      toRemove.push({ overlayId: t.config.targetId, triggerId: t.triggerId });
    }
  }
  // Nested OVERLAY NODES: one overlay element living inside another's subtree.
  for (const s of spans) {
    if (insideAnyOverlay(s.start, s.overlayId)) {
      const ov = overlays.find(o => o.overlayId === s.overlayId);
      toRemove.push({ overlayId: s.overlayId, triggerId: ov?.config.triggerId || '' });
    }
  }
  if (toRemove.length === 0) return code;

  let result = code;
  const seen = new Set<string>();
  for (const r of toRemove) {
    if (seen.has(r.overlayId)) continue; // a node could be both — remove once
    seen.add(r.overlayId);
    result = removeOverlayInCode(result, r.overlayId, r.triggerId);
    trace.action('overlay-gen:strip-nested-overlay', r);
  }
  return result;
}

/**
 * Extract an overlay's mechanism when its TRIGGER is dragged out to the canvas.
 *
 * `canvasNodes` is a MODULE-scope fragment (no hooks) and is editor-only (never
 * rendered on the published site). So the overlay there can't — and needn't —
 * keep its runtime `useState` / `useLayoutEffect` / `onClick`. We:
 *   - MOVE the overlay element into `canvasNodes` as plain metadata JSX: keep
 *     `data-overlay` (so the editor can still position it relative to its
 *     trigger), flip `position: fixed → absolute` + add a left/top placeholder,
 *     mark it `data-canvas-node`. The framer-motion appear props are harmless
 *     editor metadata, so they ride along.
 *   - REMOVE the conditional `{open && …}` wrapper + the `useState` + the
 *     `useLayoutEffect`.
 *   - DROP the trigger's `onClick` but KEEP its `data-overlay-trigger` (so the
 *     pairing survives — rehydrated when dragged back into a viewport).
 *
 * The trigger element itself is moved to `canvasNodes` separately by the move
 * generator; this runs first so the moved trigger carries clean metadata.
 */
export function extractOverlayToCanvasInCode(
  code: string,
  triggerId: string,
  placeholderLeft = 0,
  placeholderTop = 0,
): string {
  trace.fn('overlay-gen:extractToCanvas', { triggerId });

  const trig = parseOverlayTriggerCalls(code).find(t => t.triggerId === triggerId);
  if (!trig) return code;
  const overlayId = trig.config.targetId;
  const varName = stateVarName(overlayId);
  const esc = escapeRegExp(varName);

  // 1. Capture the overlay element markup. If it's already gone, just clean up.
  const idIdx = findJSXDataIdIndex(code, overlayId);
  if (idIdx < 0) return removeOverlayInCode(code, overlayId, triggerId);
  const tagStart = code.lastIndexOf('<', idIdx);
  const elementEnd = findElementEnd(code, tagStart);
  if (tagStart < 0 || elementEnd < 0) return removeOverlayInCode(code, overlayId, triggerId);
  let markup = code.slice(tagStart, elementEnd);

  // Already a canvas node (extracted on a previous gesture)? No-op — re-running
  // extract would capture it and APPEND a transformed COPY (a duplicate
  // `data-id`, with a doubled `data-canvas-node`). Just leave it.
  if (/data-canvas-node/.test(markup)) return code;

  // FIXED overlays (modals) NEVER detach to the canvas — a modal is a page-level
  // concept that STAYS in the page return when its trigger is dragged out. We only
  // strip the trigger's runtime handler (a module-scope `canvasNodes` trigger
  // can't reference the function-local setter), keeping the overlay + useState +
  // useEffect intact. Extracting it instead removed the useState, left the fixed
  // `useEffect` dangling (heal re-added the useState), then a drag-back-in
  // rehydrated it AS RELATIVE and added ANOTHER useState → "Identifier …Open has
  // already been declared" crash. (Re-armed on drag-back-in by rehydrate.)
  {
    const ovAttr = markup.match(/data-overlay='([^']*)'/);
    let isFixed = false;
    if (ovAttr) { try { isFixed = JSON.parse(ovAttr[1]).type === 'fixed'; } catch { /* skip */ } }
    if (isFixed) {
      const setVarName = `set${varName.charAt(0).toUpperCase() + varName.slice(1)}`;
      trace.action('overlay-gen:extractToCanvas:fixed-stays', { triggerId, overlayId });
      return stripOverlayHandlers(code, setVarName);
    }
  }

  // 2. Transform markup → canvas node: add data-canvas-node, fixed→absolute+pos.
  const tagClose = findTagClose(markup, 0);
  if (tagClose > 0) {
    const insertAt = markup[tagClose - 1] === '/' ? tagClose - 1 : tagClose;
    markup = markup.slice(0, insertAt) + ' data-canvas-node="true"' + markup.slice(insertAt);
  }
  markup = markup.replace(
    /position:\s*'fixed'/,
    `position: 'absolute', left: '${Math.round(placeholderLeft)}px', top: '${Math.round(placeholderTop)}px'`,
  );

  // 3. Remove the conditional block + useState + positioner effect (NOT the
  //    trigger attr — keep data-overlay-trigger; drop only the onClick/handlers).
  let result = removeOverlayConditionalBlock(code, overlayId, varName);
  result = result.replace(new RegExp(`\\s*const\\s*\\[${esc},\\s*\\w+\\]\\s*=\\s*useState\\(false\\);?\\n?`), '\n');
  // SCOPED effect removal — anchor on this overlay's UNIQUE `, [<var>]);` dep array and
  // walk back to its own effect opener (`removeOverlayEffectBlock`), NOT a lazy
  // `useLayoutEffect(() => {…[data-id="X"]…}` regex. The old regex anchored on the FIRST
  // `useLayoutEffect(` in the file; when THIS overlay's effect wasn't first, the lazy
  // `[\s\S]*?` spanned from the first effect across every intermediate overlay's
  // useState + effect to this one's `[data-id]` — wiping ALL of them ("References
  // undefined identifiers …Open" crash when dragging a non-first overlay's trigger out).
  result = removeOverlayEffectBlock(result, varName);
  const setterName = `set${varName.charAt(0).toUpperCase() + varName.slice(1)}`;
  result = stripOverlayHandlers(result, setterName);

  // 4. Insert the transformed overlay markup into canvasNodes.
  const indented = '  ' + markup.replace(/\n/g, '\n  ');
  const closeIdx = findCanvasNodesFragmentClose(result);
  if (closeIdx !== -1) {
    result = result.slice(0, closeIdx) + '\n' + indented + '\n' + result.slice(closeIdx);
  } else {
    const exportIdx = findExportDefaultEndIdx(result);
    const block = `\n\nconst canvasNodes = (<>\n${indented}\n</>);\n`;
    result = exportIdx !== -1 ? result.slice(0, exportIdx) + block + result.slice(exportIdx) : result + block;
  }

  trace.action('overlay-gen:extractToCanvas:done', { triggerId, overlayId });
  return result;
}

/**
 * Rehydrate a canvas-extracted overlay when its trigger is dragged BACK into a
 * viewport — the exact inverse of `extractOverlayToCanvasInCode`. The overlay
 * lost its runtime on the canvas (a `canvasNodes` element is editor-only and
 * never executed), so on the live site the trigger can't open it. This restores
 * the full mechanism:
 *   - MOVE the overlay element out of `canvasNodes` back into the page return as
 *     a conditional `{<id>Open && <overlay/>}` (last child of root), flipping
 *     `position: absolute` + left/top placeholder → `position: fixed` (+ zIndex)
 *     and dropping `data-canvas-node`. User content / styles are preserved.
 *   - RE-ADD the `useState` + the positioning `useLayoutEffect`.
 *   - RE-ADD the trigger's `onClick`/hover handler (its `data-overlay-trigger`
 *     pairing was kept through the round-trip).
 *
 * No-op when there's no overlay-trigger pairing, or the overlay isn't a canvas
 * node (already a live viewport overlay — nothing to rehydrate).
 */
export function rehydrateOverlayFromCanvasInCode(code: string, triggerId: string): string {
  trace.fn('overlay-gen:rehydrate', { triggerId });

  const trig = parseOverlayTriggerCalls(code).find(t => t.triggerId === triggerId);
  if (!trig?.config.targetId) return code;
  const overlayId = trig.config.targetId;
  const triggerConfig = trig.config;

  // GATE: only rehydrate when the trigger lands in EXECUTABLE scope (the return).
  // Dragging a canvas trigger INTO ANOTHER CANVAS FRAME keeps it inside the
  // module-scope `canvasNodes` fragment (still editor-only) — adding the runtime
  // there would emit a `{<id>Open && …}` conditional + `onClick` referencing a
  // function-local `useState` from module scope → "undefined identifier" crash.
  // `const canvasNodes` always sits AFTER the component, so a trigger whose JSX
  // index is past it is still on the canvas — skip.
  const trigJsxIdx = findJSXDataIdIndex(code, triggerId);
  const canvasNodesStart = code.indexOf('const canvasNodes');
  if (trigJsxIdx < 0 || (canvasNodesStart >= 0 && trigJsxIdx > canvasNodesStart)) return code;

  // 1. Capture the overlay element (lives in canvasNodes, AFTER the function
  //    body — so removing it later won't shift any function-body indices).
  const idIdx = findJSXDataIdIndex(code, overlayId);
  if (idIdx < 0) return code; // overlay gone — nothing to rehydrate
  const tagStart = code.lastIndexOf('<', idIdx);
  const elementEnd = findElementEnd(code, tagStart);
  if (tagStart < 0 || elementEnd < 0) return code;
  let markup = code.slice(tagStart, elementEnd);

  // FIXED overlay that STAYED in the return (its trigger was dragged out, which
  // only stripped the trigger's handler — see extractOverlayToCanvasInCode). On
  // drag-back-in just RE-ADD the trigger handler (+ overlay hover mirror). The
  // useState/useEffect never left — re-adding them (the relative path below)
  // would DUPLICATE the `…Open` useState → the "already declared" crash.
  {
    let isFixed = false;
    const ovAttr = markup.match(/data-overlay='([^']*)'/);
    if (ovAttr) { try { isFixed = JSON.parse(ovAttr[1]).type === 'fixed'; } catch { /* skip */ } }
    if (isFixed && !/data-canvas-node/.test(markup)) {
      const fVar = stateVarName(overlayId);
      const fSet = `set${fVar.charAt(0).toUpperCase() + fVar.slice(1)}`;
      let result = code;
      // re-add the trigger handler
      const tIdx = findJSXDataIdIndex(result, triggerId);
      if (tIdx >= 0) {
        const tStart = result.lastIndexOf('<', tIdx);
        const tClose = findTagClose(result, tStart);
        if (tStart >= 0 && tClose >= 0) {
          let tTag = stripOverlayHandlers(result.slice(tStart, tClose), fSet);
          tTag = appendAttrsToOpeningTag(tTag, buildOverlayHandlerAttr(triggerConfig, overlayId));
          result = result.slice(0, tStart) + tTag + result.slice(tClose);
        }
      }
      // re-add the overlay's hover mirror (no-op for click triggers)
      const oIdx = findJSXDataIdIndex(result, overlayId);
      if (oIdx >= 0) {
        const oStart = result.lastIndexOf('<', oIdx);
        const oClose = findTagClose(result, oStart);
        if (oStart >= 0 && oClose >= 0) {
          let oTag = stripOverlayHandlers(result.slice(oStart, oClose), fSet);
          oTag = appendAttrsToOpeningTag(oTag, buildOverlayHoverMirrorAttr(triggerConfig, overlayId, triggerId));
          result = result.slice(0, oStart) + oTag + result.slice(oClose);
        }
      }
      trace.action('overlay-gen:rehydrate:fixed-rearm', { triggerId, overlayId });
      return result;
    }
  }

  // Only rehydrate a CANVAS overlay — if it's already a live viewport overlay,
  // there's nothing to restore (avoids double-wrapping a normal reparent).
  if (!/data-canvas-node/.test(markup)) return code;

  // 2. Transform markup → live viewport overlay:
  //    drop data-canvas-node, flip absolute+left/top → fixed (+ ensure zIndex).
  markup = markup.replace(/\s*data-canvas-node="true"/, '');
  markup = markup.replace(
    /position:\s*'absolute',\s*left:\s*'-?[0-9.]+px',\s*top:\s*'-?[0-9.]+px'/,
    "position: 'fixed'",
  );
  // Defensive fallbacks if the style order differs from what extract/create wrote.
  markup = markup.replace(/position:\s*'absolute'/, "position: 'fixed'");
  markup = markup.replace(/\s*left:\s*'-?[0-9.]+px',/, '');
  markup = markup.replace(/\s*top:\s*'-?[0-9.]+px',/, '');
  if (!/zIndex:/.test(markup)) markup = markup.replace(/position:\s*'fixed'/, "position: 'fixed', zIndex: 50");

  // 3. Remove the overlay element from canvasNodes (indices before it intact).
  let result = code.slice(0, tagStart) + code.slice(elementEnd);

  // 4. Locate the TRIGGER element (now back in the return). JSX-aware so we skip
  //    `[data-id="x"]` CSS selectors in `<style>` blocks (the container-query
  //    hide rules) — a raw indexOf matched those first and spliced the handler
  //    into `<style>`, and made the conditional fall back to module scope.
  const triggerIdx = findJSXDataIdIndex(result, triggerId);
  if (triggerIdx < 0) { trace.error('overlay-gen:rehydrate:trigger-not-found', { triggerId }); return result; }
  const tStart = result.lastIndexOf('<', triggerIdx);
  let tDepth = 0, tClose = -1;
  for (let i = tStart; i < result.length; i++) {
    if (result[i] === '{') tDepth++;
    else if (result[i] === '}') tDepth--;
    else if (result[i] === '>' && tDepth === 0) { tClose = i; break; }
  }
  const tElementEnd = findElementEnd(result, tStart);
  // Safe in-return insertion point for the conditional (NEVER result.length,
  // which lands at module scope after `canvasNodes` → undefined-identifier crash).
  const fallbackInsert = tElementEnd >= 0 ? tElementEnd : (tClose >= 0 ? tClose + 1 : result.length);

  // 5. Re-add the runtime, inserting bottom-to-top so positions don't shift.
  //    Re-wrap in <AnimatePresence> so the enter/exit animation works again (the
  //    overlay markup kept its initial/animate/exit props through the canvas
  //    round-trip); removeOverlayConditionalBlock swallows it on the way out.
  const varName = stateVarName(overlayId);
  const indent = '      ';
  const overlayContent = `\n${indent}<AnimatePresence>{${varName} && (\n${indent}  ${markup.replace(/\n/g, `\n${indent}  `)}\n${indent})}</AnimatePresence>`;
  const stateDecl = `  const [${varName}, set${varName.charAt(0).toUpperCase() + varName.slice(1)}] = useState(false);\n`;

  // 5a. Conditional overlay block as last child of root (fallback = right after
  //     the trigger element — both are AFTER tClose, so 5b stays valid).
  result = insertOverlayContentAsRootLastChild(result, overlayContent, fallbackInsert);

  // 5b. Trigger handler at the trigger tag close (data-overlay-trigger pairing
  //     is already present from the round-trip).
  if (tClose >= 0) {
    result = result.slice(0, tClose) + buildOverlayHandlerAttr(triggerConfig, overlayId) + result.slice(tClose);
  }

  // 5c. useState + positioning useLayoutEffect at the top of the component.
  const statePos = findStateInsertPos(result);
  if (statePos >= 0) {
    result = result.slice(0, statePos) + stateDecl + buildRelativeOverlayPosEffect(overlayId) + result.slice(statePos);
  }

  trace.action('overlay-gen:rehydrate:done', { triggerId, overlayId });
  return result;
}

/**
 * Self-heal a DANGLING overlay runtime: a `{<var>Open && …}` conditional (or its
 * positioning effect / onClick) referencing a `useState` that no longer exists.
 * This happens when a sequence of detach/extract/rehydrate/remove operations on
 * component variants leaves the conditional behind but drops the `useState` —
 * the validator then blocks the NEXT mutation ("references undefined identifier
 * <var>Open"). We re-declare the missing `useState(false)` inside the component
 * body so the reference resolves. Idempotent (declared vars are skipped). Safe to
 * run after every move into a viewport.
 */
export function healDanglingOverlayState(code: string): string {
  // Vars referenced by an overlay conditional `{<x>Open && …}` OR the positioning
  // effect's dep `}, [<x>Open])` (either can survive a partial removal).
  const referenced = new Set<string>();
  for (const m of code.matchAll(/\{\s*(\w+Open)\s*&&/g)) referenced.add(m[1]);
  for (const m of code.matchAll(/\}\s*,\s*\[\s*(\w+Open)\s*\]\)/g)) referenced.add(m[1]);
  let result = code;
  // DEDUP first: a corrupted extract/rehydrate could leave the SAME
  // `const [<x>Open, set<x>Open] = useState(false)` TWICE → "Identifier …Open has
  // already been declared" crash. Keep the first, drop later copies. (Self-heals a
  // file that already crashed; the fixed extract/rehydrate paths no longer produce
  // it.)
  let removed = 0;
  const seenState = new Set<string>();
  result = result.replace(
    /\n?[ \t]*const\s*\[\s*(\w+Open)\s*,\s*set\w+\s*\]\s*=\s*useState\(false\);/g,
    (full, v: string) => {
      if (seenState.has(v)) { removed++; return ''; }
      seenState.add(v);
      return full;
    },
  );
  let added = 0;
  for (const varName of referenced) {
    if (new RegExp(`const\\s*\\[\\s*${escapeRegExp(varName)}\\s*,`).test(result)) continue; // already declared
    const setter = `set${varName.charAt(0).toUpperCase() + varName.slice(1)}`;
    const statePos = findStateInsertPos(result);
    if (statePos < 0) continue;
    result = result.slice(0, statePos) + `  const [${varName}, ${setter}] = useState(false);\n` + result.slice(statePos);
    added++;
  }
  if (added || removed) trace.action('overlay-gen:healDanglingState', { added, removed });
  return result;
}

/** Backward/forward-expand an overlay element's [tagStart, elementEnd] to swallow
 *  any wrapping `<AnimatePresence>{<var> && ( … )}</AnimatePresence>` (or the
 *  bare `{<var> && ( … )}`). Returns the full removal range; if the element is
 *  NOT wrapped (a canvas overlay, or a corrupted bare one), returns the element
 *  bounds unchanged. */
function overlayRemovalRange(code: string, tagStart: number, elementEnd: number): [number, number] {
  let start = tagStart;
  const end = elementEnd;
  let j = tagStart - 1;
  const skipWs = () => { while (j >= 0 && /\s/.test(code[j])) j--; };
  skipWs();
  // The wrapping parens are OPTIONAL — both generated forms must be handled:
  //   freshly generated : {xOpen && ( <motion.div … /> )}
  //   babel-reprinted   : {xOpen && <motion.div … />}
  // Every structural rewrite (a section DUPLICATE among them) round-trips the
  // file through babel, which drops the parens. Requiring `(` made the range
  // collapse to the ELEMENT alone, so pruning an orphaned overlay left
  // `{xOpen && }` behind — a syntax error the mutation validator then blocked,
  // which is why deleting a duplicated section failed with "Unexpected token"
  // while deleting the original worked (user report 2026-07-25). Mirrors
  // `findOverlayBlockSpan`, which already treats the paren as optional.
  let hadOpenParen = false;
  if (code[j] === '(') { hadOpenParen = true; j--; skipWs(); }
  if (!(code[j] === '&' && code[j - 1] === '&')) return [start, end];
  j -= 2; skipWs();
  while (j >= 0 && /[\w$]/.test(code[j])) j--; // skip the `<var>Open` identifier
  skipWs();
  if (code[j] !== '{') return [start, end];
  j--; skipWs();
  const AP = '<AnimatePresence>';
  if (code.slice(j - AP.length + 1, j + 1) === AP) j -= AP.length;
  start = j + 1;
  // Forward: the closing `)` only when we consumed an opening one (keeps the
  // pair balanced), then `}` and an optional `</AnimatePresence>`.
  let k = elementEnd;
  while (k < code.length && /\s/.test(code[k])) k++;
  if (hadOpenParen) {
    if (code[k] !== ')') return [tagStart, elementEnd];
    k++; while (k < code.length && /\s/.test(code[k])) k++;
  }
  if (code[k] !== '}') return [tagStart, elementEnd];
  k++;
  let m = k; while (m < code.length && /\s/.test(code[m])) m++;
  const APC = '</AnimatePresence>';
  if (code.slice(m, m + APC.length) === APC) k = m + APC.length;
  return [start, k];
}

/**
 * Self-heal a BARE runtime overlay — a `data-overlay` element sitting in the
 * component return (NOT a `data-canvas-node`) that has a live `useState`
 * (`<id>Open`) but is NOT gated behind `{<id>Open && …}` / `<AnimatePresence>`. It
 * therefore renders UNCONDITIONALLY (visible on load instead of on trigger click).
 * This happens when a canvas→variant drag rehydrates the state/effect/handler but
 * the overlay element lands unwrapped. We wrap it in
 * `<AnimatePresence>{<id>Open && ( <motion.div … /> )}</AnimatePresence>`, converting
 * the bare `<div>` to a `motion.div` + Appear props so it animates in/out. Idempotent —
 * "already gated" is detected by a BACKWARD-ONLY scan (`isOverlayGated`) that does NOT
 * depend on `findElementEnd` (the forward element-bounds scan is unreliable for a fixed
 * overlay's deeply-nested motion props, and a false "not wrapped" caused catastrophic
 * re-wrapping — nested `<AnimatePresence>` stacks). `AnimatePresence` is added to the
 * framer-motion import by the flush's `syncImports`.
 */
export function healUnwrappedOverlayInCode(code: string): string {
  let result = code;
  let healed = 0;
  // Re-scan from scratch each pass — wrapping shifts indices.
  for (let guard = 0; guard < 50; guard++) {
    const overlays = parseOverlayCalls(result);
    let didOne = false;
    for (const ov of overlays) {
      const overlayId = ov.overlayId;
      const varName = stateVarName(overlayId);
      // Runtime overlay only: its `useState` must exist (canvas overlays have none).
      if (!new RegExp(`const\\s*\\[\\s*${escapeRegExp(varName)}\\s*,`).test(result)) continue;
      const idIdx = findJSXDataIdIndex(result, overlayId);
      if (idIdx < 0) continue;
      const tagStart = result.lastIndexOf('<', idIdx);
      const tagClose = findTagClose(result, idIdx);
      if (tagStart < 0 || tagClose < 0) continue;
      // Canvas overlays are static — never wrap them.
      if (/data-canvas-node/.test(result.slice(tagStart, tagClose + 1))) continue;
      // Already gated behind `{<var>Open && …}`? Skip. Backward-only — must NOT rely on
      // findElementEnd (a wrong end on a fixed overlay's nested props would re-wrap).
      if (isOverlayGated(result, tagStart, varName)) continue;
      const elementEnd = findElementEnd(result, tagStart);
      if (elementEnd < 0) continue;
      // Bare → wrap it.
      const element = result.slice(tagStart, elementEnd);
      const wrapped = wrapBareOverlayElement(element, overlayId, varName, ov.config);
      result = result.slice(0, tagStart) + wrapped + result.slice(elementEnd);
      healed++;
      didOne = true;
      break; // indices shifted — re-scan
    }
    if (!didOne) break;
  }
  if (healed) trace.action('overlay-gen:healUnwrapped', { healed });
  return result;
}

/** Is the element at `tagStart` already gated behind `{<varName> && …}` (optionally
 *  `( … )` / `<AnimatePresence>`)? Pure backward scan from the element — independent of
 *  `findElementEnd` so a fixed overlay's nested motion props can't trip it. */
function isOverlayGated(code: string, tagStart: number, varName: string): boolean {
  let j = tagStart - 1;
  const skipWs = () => { while (j >= 0 && /\s/.test(code[j])) j--; };
  skipWs();
  if (code[j] === '(') { j--; skipWs(); }
  if (!(code[j] === '&' && code[j - 1] === '&')) return false;
  j -= 2; skipWs();
  const idEnd = j;
  while (j >= 0 && /[\w$]/.test(code[j])) j--;
  return code.slice(j + 1, idEnd + 1) === varName;
}

/** Turn a bare overlay element into the gated, animated runtime form:
 *  `<AnimatePresence>{<var> && ( <motion.div key=… initial/animate/exit … /> )}</AnimatePresence>`.
 *  Converts the tag to `motion.div`, adds a `key` + Appear props if absent, preserves
 *  styles/children. Does NOT touch state/effect/handler (already present). */
function wrapBareOverlayElement(element: string, overlayId: string, varName: string, config: OverlayConfig): string {
  let el = element;
  const openMatch = el.match(/^<([\w.]+)/);
  const tagName = openMatch ? openMatch[1] : 'div';
  if (tagName !== 'motion.div') {
    el = el.replace(new RegExp(`^<${escapeRegExp(tagName)}(?=[\\s>])`), '<motion.div');
    el = el.replace(new RegExp(`</${escapeRegExp(tagName)}>\\s*$`), '</motion.div>');
  }
  const openEnd = el.indexOf('>');
  const openTag = openEnd >= 0 ? el.slice(0, openEnd) : el;
  // Ensure key=.
  if (!/\bkey=/.test(openTag)) {
    el = el.replace(/^<motion\.div\s/, `<motion.div key="${overlayId}" `);
  }
  // Ensure Appear props (insert before `style=`). Fixed = fade; relative = fade+slide.
  if (!/\binitial=/.test(openTag)) {
    const appear = config.type === 'fixed'
      ? `initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}`
      : `initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 20 }}`;
    if (/\sstyle=\{\{/.test(el)) el = el.replace(/\sstyle=\{\{/, ` ${appear} style={{`);
    else el = el.replace(/^(<motion\.div\b[^>]*?)>/, `$1 ${appear}>`);
  }
  const indent = '      ';
  return `<AnimatePresence>{${varName} && (\n${indent}  ${el.replace(/\n/g, `\n${indent}  `)}\n${indent})}</AnimatePresence>`;
}

/**
 * Prune DUPLICATE and ORPHAN overlay elements — the self-heal for the
 * canvas↔viewport round-trip. A trigger owns exactly ONE overlay (its
 * `data-overlay-trigger` targetId). Repeated extract/rehydrate gestures could
 * leave the SAME overlay `data-id` in two places (e.g. a stale copy in the
 * return AND the live one on the canvas → React duplicate-key "ghost"), or
 * strand an overlay whose id no trigger points at anymore (an orphan from a
 * re-created/re-paired overlay). Both render as extra overlays.
 *
 * Rule: for each overlay element, keep it ONLY if its id is some trigger's
 * targetId AND it sits in the SAME scope as that trigger (canvas overlay ↔
 * canvas trigger; in-return overlay ↔ in-return trigger). Remove every other
 * copy, swallowing its `{…Open && (…)}`/`AnimatePresence` wrapper. Idempotent;
 * a healthy file (one overlay per trigger, matching scope) is returned
 * unchanged. Runs at flush after overlay-structural mutations, before
 * `healDanglingOverlayState` re-declares any genuinely-needed state.
 */
export function pruneOverlayDuplicatesInCode(code: string): string {
  const canvasNodesStart = code.indexOf('const canvasNodes');
  const inCanvas = (idx: number) => canvasNodesStart >= 0 && idx > canvasNodesStart;

  // targetId → is the paired TRIGGER a canvas node?
  const triggers = parseOverlayTriggerCalls(code);
  const targetScope = new Map<string, boolean>();
  for (const t of triggers) {
    if (!t.config?.targetId) continue;
    const trigIdx = findJSXDataIdIndex(code, t.triggerId);
    targetScope.set(t.config.targetId, inCanvas(trigIdx));
  }

  // Collect every overlay ELEMENT occurrence (data-overlay='…', NOT -trigger).
  interface Occ { id: string; tagStart: number; elementEnd: number; isCanvas: boolean }
  const occ: Occ[] = [];
  const seenTags = new Set<number>();
  for (const m of code.matchAll(/data-overlay='/g)) {
    const attrIdx = m.index!;
    const tagStart = code.lastIndexOf('<', attrIdx);
    if (tagStart < 0 || seenTags.has(tagStart)) continue;
    seenTags.add(tagStart);
    const tagClose = findTagClose(code, tagStart);
    if (tagClose < 0) continue;
    const idMatch = code.slice(tagStart, tagClose).match(/data-id="([^"]+)"/);
    if (!idMatch) continue;
    const elementEnd = findElementEnd(code, tagStart);
    if (elementEnd < 0) continue;
    occ.push({ id: idMatch[1], tagStart, elementEnd, isCanvas: inCanvas(tagStart) });
  }

  // Decide which occurrences to drop.
  const byId = new Map<string, Occ[]>();
  for (const o of occ) { (byId.get(o.id) ?? byId.set(o.id, []).get(o.id)!).push(o); }
  const remove: Occ[] = [];
  for (const [id, copies] of byId) {
    if (!targetScope.has(id)) { remove.push(...copies); continue; } // orphan — no trigger points here
    const wantCanvas = targetScope.get(id)!;
    let kept = false;
    // Prefer the copy whose scope matches the trigger; keep exactly one.
    const ordered = [...copies].sort((a, b) => Number(b.isCanvas === wantCanvas) - Number(a.isCanvas === wantCanvas));
    for (const c of ordered) {
      if (!kept && c.isCanvas === wantCanvas) { kept = true; continue; }
      if (!kept && ordered.every(x => x.isCanvas !== wantCanvas)) { kept = true; continue; } // none match → keep first
      remove.push(c);
    }
  }
  if (!remove.length) return code;

  // Splice from highest start to lowest so earlier indices stay valid.
  const ranges = remove
    .map(o => overlayRemovalRange(code, o.tagStart, o.elementEnd))
    .sort((a, b) => b[0] - a[0]);
  let result = code;
  for (const [s, e] of ranges) result = result.slice(0, s) + result.slice(e);
  trace.action('overlay-gen:pruneDuplicates', { removed: remove.length, ids: [...new Set(remove.map(o => o.id))] });
  return result;
}

/**
 * Lift any canvas overlay that is NESTED inside another canvas element (a canvas
 * FRAME) back to the TOP LEVEL of the `canvasNodes` fragment. INVARIANT: a canvas
 * overlay is ALWAYS a top-level canvas node, positioned in canvas-absolute space
 * relative to its trigger by `Renderer.positionCanvasNodeOverlays`.
 *
 * When a canvas trigger is dragged INTO a canvas frame its overlay can ride along
 * and become a child of that frame, then get STRANDED there when the trigger is
 * dragged back OUT — the overlay's left/top are now frame-LOCAL and the frame's
 * `overflow:hidden` clips it off-screen ("overlay invisible / behind the frame on
 * drag-out"). Hoisting it back to root restores absolute positioning (the next
 * `positionCanvasNodeOverlays` render re-derives its coords from the trigger, so
 * the stale frame-local left/top are immaterial). Idempotent — a file whose
 * canvas overlays are all already top-level is returned unchanged.
 */
/**
 * Relocate a runtime overlay that was mis-inserted NEXT TO ITS TRIGGER back to
 * the last child of `data-id="root"` — the placement the dialect requires
 * (`OVERLAY_NOT_ROOT_CHILD`, oracle/checks/overlay-dialect.ts).
 *
 * Repairs pages already written by the broken insertion heuristic (see
 * `insertOverlayContentAsRootLastChild`): it sliced the return statement at the
 * first `;` after the root's opening tag, so any `;` inside the JSX — most
 * commonly the `<style>{`…`}</style>` block the responsive system writes for
 * `@media` overrides — sent every new overlay to a fallback position immediately
 * after its trigger element, deep inside a section. Those pages keep rendering
 * the overlay in the wrong containing block until something moves it, so heal on
 * the next overlay-structural flush rather than making the user delete and
 * recreate.
 *
 * Two fingerprints, both unambiguous corruptions:
 *
 *   (a) INSIDE root but sitting directly after its own trigger — the fallback
 *       position the broken heuristic used.
 *   (b) OUTSIDE root entirely — stranded past the root element's closing tag, in
 *       the worst case at MODULE SCOPE after the component's `}`. That block
 *       references the component's `<id>Open` hook variable, so the file has a
 *       dangling identifier: the page is dead AND every later overlay action is
 *       refused by the mutation validator ("References undefined identifier"),
 *       which traps the user with no way out. Live find 2026-07-25.
 *
 * Canvas overlays are static metadata with no `{open && …}` wrapper, so
 * `findOverlayBlockSpan` returns null for them and they're skipped —
 * `liftNestedCanvasOverlaysToRoot` owns that case. Component masters have no
 * `data-id="root"` and are skipped wholesale (their overlays legitimately live
 * inside the variant root).
 */
export function healMisplacedOverlayInCode(code: string): string {
  if (findJSXDataIdIndex(code, 'root') < 0) return code;
  let result = code;

  for (const call of parseOverlayCalls(code)) {
    const overlayId = call.overlayId;
    const triggerId = (call.config as { triggerId?: string }).triggerId;
    if (!triggerId || triggerId === overlayId) continue;

    let span = findOverlayBlockSpan(result, overlayId, stateVarName(overlayId));
    if (!span) continue; // static canvas overlay / unrecognized wrapper — leave it

    const rootCloseStart = findRootCloseTagStart(result);
    if (rootCloseStart < 0) continue;

    // (b) OUTSIDE root — always a corruption for a runtime (hook-gated) overlay.
    const isStranded = span.start > rootCloseStart;

    if (!isStranded) {
      // (a) Directly after its own trigger?
      const trigIdx = findJSXDataIdIndex(result, triggerId);
      if (trigIdx < 0) continue;
      const trigTagStart = result.lastIndexOf('<', trigIdx);
      const trigEnd = findElementEnd(result, trigTagStart);
      if (trigEnd < 0 || trigEnd > span.start) continue;
      if (result.slice(trigEnd, span.start).trim() !== '') continue;
      // Already root's last child? Then "after the trigger" is a coincidence
      // (the trigger is the previous sibling) — moving it would only churn.
      if (span.end <= rootCloseStart && result.slice(span.end, rootCloseStart).trim() === '') continue;
    } else {
      // Swallow the expression-statement `;` so the lift doesn't leave a stray
      // empty statement at module scope.
      let after = span.end;
      while (after < result.length && /\s/.test(result[after])) after++;
      if (result[after] === ';') span = { start: span.start, end: after + 1 };
    }

    const block = result.slice(span.start, span.end);
    const without = result.slice(0, span.start) + result.slice(span.end);
    // Re-insert into the CUT string — `insertOverlayContentAsRootLastChild`
    // re-derives root's closing tag, so the removed span can't leave it stale.
    // `fallbackPos: -1` = NO-OP if that fails: appending at EOF would strand the
    // block outside the component function (module-scope JSX referencing a hook
    // variable — a blank page). Leaving it misplaced is strictly better.
    const moved = insertOverlayContentAsRootLastChild(without, '\n      ' + block.trim().replace(/;$/, ''), -1);
    if (moved === without) continue; // root close not resolvable — keep the original
    trace.action('overlay-gen:heal-misplaced-overlay', {
      overlayId, triggerId, fromStart: span.start, blockLen: block.length, stranded: isStranded,
    });
    result = moved;
  }

  return result;
}

export function liftNestedCanvasOverlaysToRoot(code: string): string {
  const cnIdx = code.indexOf('const canvasNodes');
  if (cnIdx < 0) return code;
  const fragOpen = code.indexOf('<>', cnIdx);
  if (fragOpen < 0) return code;
  const fragContentStart = fragOpen + 2;
  const fragClose = findCanvasNodesFragmentClose(code);
  if (fragClose < 0 || fragClose <= fragContentStart) return code;

  // Top-level element ranges directly under the fragment.
  const topLevel: Array<[number, number]> = [];
  let pos = fragContentStart;
  while (pos < fragClose) {
    while (pos < fragClose && code[pos] !== '<') pos++;
    if (pos >= fragClose || code.slice(pos, pos + 2) === '</') break;
    const end = findElementEnd(code, pos);
    if (end < 0) break;
    topLevel.push([pos, end]);
    pos = end;
  }

  // Every overlay element occurrence inside the fragment.
  interface Occ { tagStart: number; elementEnd: number; id: string }
  const nested: Occ[] = [];
  for (const m of code.matchAll(/data-overlay='/g)) {
    const attrIdx = m.index!;
    if (attrIdx < fragContentStart || attrIdx > fragClose) continue;
    const tagStart = code.lastIndexOf('<', attrIdx);
    const tagClose = findTagClose(code, tagStart);
    if (tagClose < 0) continue;
    const idM = code.slice(tagStart, tagClose).match(/data-id="([^"]+)"/);
    if (!idM) continue;
    const elementEnd = findElementEnd(code, tagStart);
    if (elementEnd < 0) continue;
    // NESTED = enclosed by a top-level element that is NOT itself.
    const isNested = topLevel.some(([s, e]) => s !== tagStart && tagStart > s && elementEnd <= e);
    if (isNested) nested.push({ tagStart, elementEnd, id: idM[1] });
  }
  if (!nested.length) return code;

  // Strip each (highest first) and collect markup; re-append at fragment top level.
  let result = code;
  const lifted: string[] = [];
  for (const ov of [...nested].sort((a, b) => b.tagStart - a.tagStart)) {
    let markup = result.slice(ov.tagStart, ov.elementEnd);
    result = result.slice(0, ov.tagStart) + result.slice(ov.elementEnd);
    if (!/data-canvas-node/.test(markup)) {
      const tc = findTagClose(markup, 0);
      if (tc > 0) {
        const insertAt = markup[tc - 1] === '/' ? tc - 1 : tc;
        markup = markup.slice(0, insertAt) + ' data-canvas-node="true"' + markup.slice(insertAt);
      }
    }
    lifted.push(markup);
  }
  const newClose = findCanvasNodesFragmentClose(result);
  if (newClose < 0) return code;
  const indented = lifted.map(m => '  ' + m.replace(/\n/g, '\n  ')).join('\n');
  result = result.slice(0, newClose) + '\n' + indented + '\n' + result.slice(newClose);
  trace.action('overlay-gen:liftNestedOverlays', { count: lifted.length, ids: nested.map(n => n.id) });
  return result;
}
