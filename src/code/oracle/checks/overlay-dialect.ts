// oracle/checks/overlay-dialect.ts — overlay dialect checks (dropdowns/modals).
// All code moved VERBATIM from check-file.ts (Phase 7.1 god-file split).

import type { NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import { stateVarName as overlayStateVarName, buildRelativeOverlayPosEffect, buildFixedOverlayRuntimeEffect } from '@/code/generation/overlay-gen';
import { traverse, jsxTagName, jsxAttrs, stringAttr } from './shared';
import type { OracleViolation } from './shared';

/** OVERLAY DIALECT — dropdowns/popovers (type 'relative') and modals
 *  (type 'fixed') are a code-first pair the editor resolves literally:
 *
 *    trigger:  data-overlay-trigger='{"targetId":"<overlay-id>","trigger":"click","dismiss":"outside"}'
 *              + onClick={() => set<Var>(!<var>)}
 *    overlay:  <AnimatePresence>{<var> && (<motion.div key data-id
 *              data-overlay='{"type":…,"triggerId":"<trigger-id>",…}' …/>)}</AnimatePresence>
 *              as the LAST CHILD OF THE ROOT (escapes trigger overflow), plus
 *    state:    const [<var>, set<Var>] = useState(false)  with
 *              <var> = stateVarName(overlayId), and the runtime effect
 *              (useLayoutEffect positioner for relative / useEffect
 *              backdrop+scroll-lock for fixed).
 *
 *  Violations carry the EXACT generated snippets so one bounce converges. */
function checkOverlayDialect(code: string, ast: t.File, v: OracleViolation[]): void {
  type OverlayInfo = { id: string; cfg: Record<string, unknown> | null; line?: number; depth: number };
  const overlays: OverlayInfo[] = [];
  const triggers: Array<{ id: string | undefined; cfg: Record<string, unknown> | null; line?: number; tagHasSetter: (setter: string) => boolean }> = [];

  traverse(ast, {
    JSXElement(path) {
      const attrs = jsxAttrs(path.node.openingElement);
      // Parked workspace nodes (data-canvas-node) sit off the artboard — the
      // canvas creates them UNWIRED and only generates the overlay state/effect/
      // wrapper/handler when the node is placed into the page. They are scratch,
      // not active overlays, so they're exempt from every overlay check: a page
      // carrying parked overlay experiments must still submit clean (prime rule —
      // canvas-produced source passes the gate). Once connected into the page
      // (no longer a canvas node) the full wiring is required as normal.
      if (stringAttr(attrs, 'data-canvas-node') === 'true') return;
      const dataId = stringAttr(attrs, 'data-id');
      const line = path.node.openingElement.loc?.start.line;
      const ov = stringAttr(attrs, 'data-overlay');
      const tr = stringAttr(attrs, 'data-overlay-trigger');
      if (ov !== undefined) {
        let cfg: Record<string, unknown> | null = null;
        try { cfg = JSON.parse(ov); } catch { /* flagged below */ }
        // JSX ancestry depth to the nearest element ancestor (skipping the
        // expression/AnimatePresence wrappers): the overlay must hang off the
        // ROOT element, not sit inside the trigger/subtree.
        let depth = 0;
        let pp: NodePath | null = path.parentPath;
        while (pp) {
          if (pp.isJSXElement()) {
            const ptag = jsxTagName(pp.node.openingElement.name);
            const pbase = ptag.startsWith('motion.') ? ptag.slice('motion.'.length) : ptag;
            // Transparent wrappers don't count toward nesting — a COMPONENT
            // root sits inside LayoutGroup/MotionConfig, and its overlays are
            // still root-children.
            if (pbase !== 'AnimatePresence' && pbase !== 'LayoutGroup' && pbase !== 'MotionConfig') depth++;
          }
          pp = pp.parentPath;
        }
        overlays.push({ id: dataId ?? '', cfg, line, depth });
      }
      if (tr !== undefined) {
        let cfg: Record<string, unknown> | null = null;
        try { cfg = JSON.parse(tr); } catch { /* flagged below */ }
        const opening = path.node.openingElement;
        triggers.push({
          id: dataId, cfg, line,
          tagHasSetter: (setter: string) => {
            const start = opening.start ?? 0;
            const end = opening.end ?? start;
            return code.slice(start, end).includes(setter);
          },
        });
      }
    },
  });
  if (overlays.length === 0 && triggers.length === 0) return;

  for (const o of overlays) {
    const need = ['type', 'triggerId', 'side', 'align'];
    if (!o.cfg || need.some((k) => o.cfg![k] == null)) {
      v.push({
        code: 'OVERLAY_CONFIG_INVALID', tier: 2, line: o.line, elementId: o.id,
        message: `data-overlay on <${o.id || 'element'}> (line ${o.line}) must be a JSON object with type ('relative'|'fixed'), triggerId, side ('top'|'right'|'bottom'|'left'), align ('start'|'center'|'end'), offsetX, offsetY — e.g. data-overlay='{"type":"relative","triggerId":"menu-btn","side":"bottom","align":"start","offsetX":0,"offsetY":8}'. The overlay panel and the runtime positioner read it literally.`,
      });
      continue;
    }
    // Placement: depth 1 = direct child of the root element.
    if (o.depth > 1) {
      v.push({
        code: 'OVERLAY_NOT_ROOT_CHILD', tier: 2, line: o.line, elementId: o.id,
        message: `The overlay <${o.id}> (line ${o.line}) is nested ${o.depth} elements deep — it must be the LAST CHILD OF THE ROOT element (wrapped in <AnimatePresence>{open && (…)}</AnimatePresence>), never inside its trigger: that's how it escapes the trigger's overflow/transform on the live site, and the canvas portal expects it there.`,
      });
    }
    if (!o.id) continue;
    const varName = overlayStateVarName(o.id);
    const setVar = `set${varName.charAt(0).toUpperCase() + varName.slice(1)}`;
    const missing: string[] = [];
    if (!new RegExp(`const \\[${varName},\\s*${setVar}\\] = useState\\(false\\)`).test(code)) {
      missing.push(`the state: const [${varName}, ${setVar}] = useState(false);`);
    }
    // The conditional wrapper may be `{x && ( … )}` OR `{x && <Element … />}`
    // (direct JSX, no wrapping paren) — the editor's overlay-gen emits the
    // latter. Accept either form.
    if (!new RegExp(`\\{\\s*${varName}\\s*&&\\s*[(<]`).test(code)) {
      missing.push(`the conditional wrapper: <AnimatePresence>{${varName} && ( …overlay… )}</AnimatePresence>`);
    }
    const isFixed = o.cfg.type === 'fixed';
    const effectPresent = isFixed
      ? (code.includes(`[data-id="${o.id}"]`) && /useEffect\(/.test(code) && code.includes('prevOverflow'))
      : (code.includes(`[data-id="${o.id}"]`) && /useLayoutEffect\(/.test(code) && code.includes('getBoundingClientRect'));
    if (!effectPresent) {
      const effect = isFixed ? buildFixedOverlayRuntimeEffect(o.id) : buildRelativeOverlayPosEffect(o.id);
      missing.push(`the runtime effect (paste verbatim above the return):\n${effect}`);
    }
    if (missing.length > 0) {
      v.push({
        code: 'OVERLAY_MISSING_WIRING', tier: 2, line: o.line, elementId: o.id,
        message: `Overlay <${o.id}> (line ${o.line}) renders but is dead without its wiring — missing ${missing.length} piece(s):\n- ${missing.join('\n- ')}`,
      });
    }
  }

  // Cross-links + trigger handler
  const overlayIds = new Set(overlays.map((o) => o.id).filter(Boolean));
  for (const tr of triggers) {
    if (!tr.cfg || tr.cfg.targetId == null || tr.cfg.trigger == null) {
      v.push({
        code: 'OVERLAY_CONFIG_INVALID', tier: 2, line: tr.line, elementId: tr.id,
        message: `data-overlay-trigger on <${tr.id || 'element'}> (line ${tr.line}) must be JSON with targetId (the overlay's data-id), trigger ('click'|'hover'|'event') and dismiss ('outside'|'click'|'escape') — e.g. data-overlay-trigger='{"targetId":"overlay-menu-btn-1","trigger":"click","dismiss":"outside"}'.`,
      });
      continue;
    }
    // EVENT trigger (component-instance event): the trigger is a component
    // INSTANCE and the overlay opens when a component EVENT fires from a child
    // inside the master. It needs `eventName` (the master's callback prop), and
    // the instance passes `<eventName>={() => set<Ovl>Open(true)}`.
    if (tr.cfg.trigger === 'event' && tr.cfg.eventName == null) {
      v.push({
        code: 'OVERLAY_CONFIG_INVALID', tier: 2, line: tr.line, elementId: tr.id,
        message: `data-overlay-trigger on <${tr.id || 'element'}> (line ${tr.line}) is trigger: 'event' but has no eventName — an event trigger fires when a component EVENT fires from inside the instance, so it needs the master's event-callback prop name: data-overlay-trigger='{"targetId":"...","trigger":"event","eventName":"event1","dismiss":"outside"}' plus eventName={() => set<Ovl>Open(true)} on the instance tag.`,
      });
      continue;
    }
    const target = String(tr.cfg.targetId);
    if (!overlayIds.has(target)) {
      v.push({
        code: 'OVERLAY_LINK_BROKEN', tier: 2, line: tr.line, elementId: tr.id,
        message: `data-overlay-trigger on <${tr.id}> (line ${tr.line}) points at targetId "${target}" but no element in this file has data-id="${target}" with a data-overlay attr. The pair must cross-link: trigger.targetId === overlay's data-id AND overlay.triggerId === trigger's data-id.`,
      });
      continue;
    }
    const varName = overlayStateVarName(target);
    const setVar = `set${varName.charAt(0).toUpperCase() + varName.slice(1)}`;
    if (!tr.tagHasSetter(setVar)) {
      const handler = tr.cfg.trigger === 'event'
        ? `${tr.cfg.eventName}={() => ${setVar}(true)}`
        : tr.cfg.trigger === 'hover'
          ? `onMouseEnter={() => { clearTimeout(((window as any).__ovGrace ||= {})['${target}']); ${setVar}(true); }} onMouseLeave={(e) => { const ov = document.querySelector('[data-id="${target}"]'); if (ov && e.relatedTarget && ov.contains(e.relatedTarget)) return; const g = ((window as any).__ovGrace ||= {}); clearTimeout(g['${target}']); g['${target}'] = setTimeout(() => ${setVar}(false), 180); }}`
          : `onClick={() => ${setVar}(!${varName})}`;
      v.push({
        code: 'OVERLAY_MISSING_WIRING', tier: 2, line: tr.line, elementId: tr.id,
        message: `The trigger <${tr.id}> (line ${tr.line}) declares the overlay but has no handler — it never opens. Add to its tag: ${handler}`,
      });
    }
  }
  // Overlay whose triggerId has no matching trigger element
  const triggerIds = new Set(triggers.map((trg) => trg.id).filter(Boolean));
  for (const o of overlays) {
    if (!o.cfg?.triggerId) continue;
    const tid = String(o.cfg.triggerId);
    if (!triggerIds.has(tid)) {
      v.push({
        code: 'OVERLAY_LINK_BROKEN', tier: 2, line: o.line, elementId: o.id,
        message: `Overlay <${o.id}> (line ${o.line}) declares triggerId "${tid}" but that element carries no data-overlay-trigger attr. Add to <${tid}>: data-overlay-trigger='{"targetId":"${o.id}","trigger":"click","dismiss":"outside"}' plus the onClick handler.`,
      });
    }
  }
}


export { checkOverlayDialect };
