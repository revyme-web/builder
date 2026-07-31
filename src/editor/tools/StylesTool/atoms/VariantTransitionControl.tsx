// VariantTransitionControl.tsx — Transition control for variant elements.
// Shown as the first atom inside StylesTool when on a component master page.
//
// Routing:
//   Root + default variant  → <MotionConfig transition={...}> wrapper (propagates to all)
//   Root + non-default      → inside variant entry: transition: { ... }
//   Child + default         → transition={{...}} prop on the element (overrides MotionConfig)
//   Child + non-default     → inside variant entry: transition: { ... }

import { useState, useRef, useMemo, useCallback } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { isComponentFileAtom, selectedNodeAtom, codeAtom } from '@/code/stores/store';
import { useNode } from '@/code/stores/node-family';
import { activeFilePathAtom, isLayoutFile } from '@/code/project/active-file-store';
import { interactingViewportIdAtom } from '@/code/stores/viewport-store';
import { projectFS, projectVersionAtom } from '@/code/project/project-fs';
import { modifyProjectFile } from '@/code/project/modify-file';
import {
  updateMotionPropInCode, removeMotionPropFromCode,
  updateMotionConfigTransition, updateVariantEntryTransition, readTransitionVarRef, revertVariantTransition, setMotionConfigBaseVar,
} from '@/code/generation/generator-motion';
import { readTransitionOrphanVar } from '@/code/generation/component-var-detach-gen';
import { queueMutation } from '@/code/mutation/mutation-queue';
import { isPrimaryViewport } from '@/canvas/node-ops';
import ToolPopup from '../../../ui/ToolPopup';
import { ControlActionRow, ControlLabel } from '../../../controls';
import { LegacyVariableBoundPill } from '../../../controls/VariableBoundPill';
import { useControlOptional } from '../../../controls/ControlProvider';
import { summarizeTransition, TransitionCurveIcon } from '../../AnimationTool/CurvePreview';
import TransitionPanel from '../../AnimationTool/TransitionPanel';
import { trace } from '@/shared/debug-trace';

export default function VariantTransitionControl() {
  const isComponentFile = useAtomValue(isComponentFileAtom);
  const selectedId = useAtomValue(selectedNodeAtom);
  const code = useAtomValue(codeAtom);
  const activeFile = useAtomValue(activeFilePathAtom);
  const vpId = useAtomValue(interactingViewportIdAtom);
  const setCode = useSetAtom(codeAtom);
  const setVersion = useSetAtom(projectVersionAtom);
  const [isOpen, setIsOpen] = useState(false);
  const btnRef = useRef<HTMLDivElement>(null);

  const node = useNode(selectedId) ?? null;
  // A CANVAS NODE (dragged out to module-scope `canvasNodes`) lives OUTSIDE any MotionConfig — it has no
  // `variant` context and never inherits the component's MotionConfig transition. So it is NOT the component
  // root (despite having no parentId): its transition is ONLY its own element prop (e.g. "Default" when it has
  // none) — otherwise the control wrongly showed the inherited MotionConfig base (the reported "zefzef" leak).
  const isCanvasNode = !!node?.isCanvasNode;
  const isRoot = node ? (!node.parentId && !isCanvasNode) : false;
  const isDefaultVariant = isPrimaryViewport(vpId);
  const variantName = !isDefaultVariant ? vpId : null;

  // Determine routing mode
  const mode = useMemo(() => {
    if (isCanvasNode) return 'elementProp' as const; // free element — its OWN transition only, no MotionConfig/variant
    if (isRoot && isDefaultVariant) return 'motionConfig' as const;
    if (isRoot && !isDefaultVariant) return 'variantEntry' as const;
    if (!isRoot && isDefaultVariant) return 'elementProp' as const;
    return 'variantEntry' as const; // child + non-default
  }, [isRoot, isDefaultVariant, isCanvasNode]);

  // Read current transition based on mode
  const currentTransition = useMemo((): Record<string, string> => {
    if (!selectedId || !code) return {};

    if (mode === 'motionConfig') {
      // Read from <MotionConfig transition={{...}}>
      const match = code.match(/<MotionConfig\s+transition=\{\{([^}]*)\}\}/);
      if (!match) return {};
      const result: Record<string, string> = {};
      const propRegex = /(\w+)\s*:\s*(?:'([^']*)'|"([^"]*)"|(\d+(?:\.\d+)?))/g;
      let m;
      while ((m = propRegex.exec(match[1])) !== null) {
        result[m[1]] = m[2] ?? m[3] ?? m[4] ?? '';
      }
      return result;
    }

    if (mode === 'variantEntry' && variantName && node?.motionVariantsRef) {
      // Read transition from inside variant entry
      const constName = node.motionVariantsRef;
      const constIdx = code.indexOf(`const ${constName}`);
      if (constIdx === -1) return {};
      const afterConst = code.slice(constIdx);
      // Find the variant entry
      const entryRegex = new RegExp(`'?${variantName}'?\\s*:\\s*\\{`);
      const entryMatch = afterConst.match(entryRegex);
      if (!entryMatch) return {};
      const entryStart = constIdx + afterConst.indexOf(entryMatch[0]) + entryMatch[0].length;
      // Find transition: { ... } inside the entry (brace-aware)
      const entrySlice = code.slice(entryStart, entryStart + 500);
      const transMatch = entrySlice.match(/transition\s*:\s*\{([^}]*)\}/);
      if (!transMatch) return {};
      const result: Record<string, string> = {};
      const propRegex = /(\w+)\s*:\s*(?:'([^']*)'|"([^"]*)"|(\d+(?:\.\d+)?))/g;
      let m;
      while ((m = propRegex.exec(transMatch[1])) !== null) {
        result[m[1]] = m[2] ?? m[3] ?? m[4] ?? '';
      }
      return result;
    }

    // elementProp mode — read from motionProps.transition
    if (!node?.motionProps?.transition) return {};
    const t = node.motionProps.transition;
    const result: Record<string, string> = {};
    for (const [k, v] of Object.entries(t)) {
      if (!k.startsWith('_')) result[k] = String(v);
    }
    return result;
  }, [selectedId, code, mode, variantName, node]);

  // NEW-FORM transition variable: the variable lives in the framer-motion transition (MotionConfig /
  // variant-entry / element-prop) as a bare identifier — per-variant native. Detect it directly from the code
  // by the same `mode` routing the control reads/writes. (Legacy form = a style.transition variable, detected
  // via ctl.getValueSource below; both surface the pill, but new-form removal routes through the transition
  // generators instead of the corrupting CSS unbind.)
  const newFormVarRef = useMemo(() => {
    if (!selectedId || !code) return null;
    // A dragged-out CANVAS NODE's per-variant transition variable is stashed in `data-var-orphan` (the live
    // `transition={tN}` ref can't exist at module scope) — surface it so the pill still shows "Transition 59".
    if (isCanvasNode) return readTransitionOrphanVar(code, selectedId);
    const own = readTransitionVarRef(code, selectedId, mode, variantName, isRoot);
    if (own) return own;
    // CASCADE: on a replica/variant with NO own transition, inherit the BASE variable (root → MotionConfig,
    // child → element-prop) — the base transition applies to every variant at runtime, so the pill shows
    // inherited on the replica too (like every other variable cascading down). BUT a tile with its OWN literal
    // override (currentTransition non-empty) is a DIVERGE — show it as an override, NOT the cascaded variable.
    if (mode === 'variantEntry') {
      if (Object.keys(currentTransition).length > 0) return null;
      return readTransitionVarRef(code, selectedId, isRoot ? 'motionConfig' : 'elementProp', null);
    }
    return null;
  }, [selectedId, code, mode, variantName, currentTransition, isRoot, isCanvasNode]);

  // This variant's OWN transition variable (NO cascade) — distinguishes "the variant has its own binding"
  // (→ strip on remove) from "inherits the base" (→ diverge on remove).
  const ownVariantVarRef = useMemo(
    () => (selectedId && code && mode === 'variantEntry' && variantName)
      ? readTransitionVarRef(code, selectedId, 'variantEntry', variantName, isRoot) : null,
    [selectedId, code, mode, variantName, isRoot],
  );

  // Variable detection. NEW-FORM = the framer-motion transition identifier (per-variant native). LEGACY = a
  // style.transition style variable (via ctl). On a replica/variant that has its OWN variant-entry transition
  // (a per-variant LITERAL override after a diverge), SUPPRESS the legacy base ref so the row reads as an
  // OVERRIDE (purple + Reset) instead of still showing the inherited base variable — design-tool parity.
  const ctl = useControlOptional();
  const valueSource = ctl?.getValueSource('transition');
  const legacyVarRef = valueSource?.source === 'prop' ? valueSource.ref : null;
  const hasOwnEntryTransition = mode === 'variantEntry' && Object.keys(currentTransition).length > 0;
  const variableRef = newFormVarRef ?? (hasOwnEntryTransition ? null : legacyVarRef);

  const handleWrite = useCallback((transition: Record<string, string>) => {
    if (!selectedId) return;
    const isInstant = transition.type === 'instant' || Object.keys(transition).length === 0;
    // "Instant" = duration: 0 (NOT removal). Without an explicit transition,
    // framer-motion uses its default spring, which still animates.
    const resolvedTransition = isInstant ? { duration: '0' } : transition;
    trace.action('variant-transition:write', { nodeId: selectedId, mode, variantName, transition: resolvedTransition });

    modifyProjectFile(activeFile, (currentCode) => {
      if (mode === 'motionConfig') {
        return updateMotionConfigTransition(currentCode, resolvedTransition);
      }
      if (mode === 'variantEntry' && variantName) {
        return updateVariantEntryTransition(currentCode, selectedId, variantName, resolvedTransition);
      }
      // elementProp mode (child + default)
      return updateMotionPropInCode(currentCode, selectedId, 'transition', resolvedTransition);
    });

    const newCode = projectFS.readFile(activeFile);
    if (newCode) { setCode(newCode); setVersion(v => v + 1); }
  }, [selectedId, activeFile, mode, variantName, setCode, setVersion]);

  // PER-VIEWPORT RESET (the X on a replica): on a non-primary viewport the transition lives in THIS tile's
  // variant entry (`mode === 'variantEntry'`). Passing `null` strips just that entry's `transition: {…}`
  // (updateVariantEntryTransition removes it + only re-adds when given a non-empty transition), so the tile
  // reverts to the base `<MotionConfig>` — exactly the reference's "remove transition from this replica". The
  // primary's transition is untouched. Mirrors the per-replica link/style override reset.
  const handleResetOverride = useCallback(() => {
    if (!selectedId || mode !== 'variantEntry' || !variantName) return;
    trace.action('variant-transition:reset-override', { nodeId: selectedId, variantName });
    modifyProjectFile(activeFile, (currentCode) => revertVariantTransition(currentCode, selectedId, variantName!));
    const newCode = projectFS.readFile(activeFile);
    if (newCode) { setCode(newCode); setVersion(v => v + 1); }
  }, [selectedId, activeFile, mode, variantName, setCode, setVersion]);

  // Removing the transition VARIABLE (the pill X). The generic ControlProvider.removeVariable routes its
  // per-viewport-replica freeze through updateStyle → writes a CORRUPT literal (`transition: '{, transition: …}'`
  // / `{{}' }`) because transition is treated as a CSS style. A transition variable is actually a STYLE variable
  // bound on the base inline style (`style={{…, transition: <prop> }}`, with `transition = "<default>"` as a
  // function prop) — NOT the variant-entry/MotionConfig transition handleWrite manages. So:
  //   • if THIS tile's variant entry carries its OWN literal transition (a per-viewport override) → strip it,
  //     reverting to the base (updateVariantEntryTransition null);
  //   • otherwise unbind the base style variable to a literal via the AST-based removeVariable MUTATION
  //     (removeVariableInCode) — it replaces the `transition: <prop>` identifier with the default + drops the
  //     prop, with no CSS-freeze corruption. (Per-replica DIVERGE of a base-bound transition var is Piece 2
  //     remaining — see [[project_transition_responsive]].)
  const handleRemoveVariable = useCallback((property: string, propName: string, defaultValue: string) => {
    if (!selectedId) return;
    const ownEntry = mode === 'variantEntry' && (!!ownVariantVarRef || Object.keys(currentTransition).length > 0);
    trace.action('variant-transition:remove-variable', { nodeId: selectedId, mode, variantName, propName, newForm: !!newFormVarRef, ownEntry });

    // ON A REPLICA/VARIANT (variantEntry mode), the pill X = DIVERGE to a LITERAL (NO variable), keeping the
    // primary's variable untouched. Remove THIS tile's own variable (element ternary) + any own literal, then
    // freeze a literal in the variant object. The tile then reads as a literal override (purple + Reset) with
    // NO pill — exactly like X on every other per-replica variable. It must NEVER re-inject the base/primary
    // variable (that injection was the bug); the *label's* Reset Override is the separate "revert to base".
    if (mode === 'variantEntry' && variantName) {
      if (!ownVariantVarRef && !variableRef && Object.keys(currentTransition).length === 0) return; // nothing bound
      const frozen = Object.keys(currentTransition).length > 0
        ? currentTransition
        : { type: 'tween', duration: '0.3', ease: 'easeInOut' };
      modifyProjectFile(activeFile, (c) => {
        const cleaned = revertVariantTransition(c, selectedId, variantName!); // drop own variable + own literal
        return updateVariantEntryTransition(cleaned, selectedId, variantName!, frozen); // freeze a literal (no var)
      });
      const newCode = projectFS.readFile(activeFile);
      if (newCode) { setCode(newCode); setVersion(v => v + 1); }
      return;
    }

    // ON THE PRIMARY (default): a NEW-FORM base → strip the framer-motion transition reference (MotionConfig /
    // element-prop), THEN delete the now-unreferenced prop + @propMeta so no ghost variable lingers. A LEGACY
    // style.transition variable → AST unbind (removeVariableInCode) to a literal + drop the prop.
    if (newFormVarRef) {
      // X on the node UNBINDS the variable from THIS node only — strip the MotionConfig / element-prop reference,
      // reverting to no transition — but KEEP the variable in the Variables list (the prop + @propMeta stay),
      // exactly like X on every other variable. Do NOT delete the whole variable (that was the reported bug).
      modifyProjectFile(activeFile, (c) =>
        // PRIMARY: clear only the BASE of the MotionConfig chain (→ `undefined`), keeping per-variant branches.
        mode === 'motionConfig' ? setMotionConfigBaseVar(c, 'undefined') : removeMotionPropFromCode(c, selectedId, 'transition'));
      const newCode = projectFS.readFile(activeFile);
      if (newCode) { setCode(newCode); setVersion(v => v + 1); }
      return;
    }
    queueMutation({ type: 'removeVariable', nodeId: selectedId, styleProperty: property, propName, defaultValue, deleteProp: true });
  }, [selectedId, activeFile, mode, variantName, currentTransition, newFormVarRef, ownVariantVarRef, variableRef, setCode, setVersion]);

  // `isComponentFileAtom` is TRUE for TEMPLATES too (component-LIKE), but the Transition control is for REAL
  // design components only — a variant transition has no meaning on a template/page. Exclude layout files.
  if (!isComponentFile || isLayoutFile(activeFile) || !selectedId) return null;

  const hasTrans = Object.keys(currentTransition).length > 0;
  // A per-viewport OVERRIDE = a non-primary tile (`variantEntry` mode) carrying its OWN transition in its
  // variant entry. Light the purple override label + Reset X (ControlLabel renders both from these props) so
  // the user can strip just this replica's transition back to the base — the reference's "remove from this replica".
  // NOT an override on the primary (motionConfig) or a child's base element-prop, and not when bound to a
  // variable (the pill owns its own X; the variable-on-replica diverge is a separate path).
  // OVERRIDE = this variant has its OWN transition that differs from the inherited base: a per-variant VARIABLE
  // (ownVariantVarRef, the element ternary) OR a per-variant LITERAL (hasTrans, the variant object). Either lights
  // the purple label + Reset Override — same rule as every other per-replica override. (An INHERITED base
  // variable is not an override → both false.)
  const overridden = mode === 'variantEntry' && (!!ownVariantVarRef || hasTrans);
  const summary = hasTrans ? summarizeTransition(currentTransition) : 'Default';
  const isSpring = currentTransition.type === 'spring';

  return (
    <>
      <div className="flex items-center justify-between w-full" ref={btnRef}>
        <ControlLabel label="Transition" property="transition" overridden={overridden} onResetOverride={handleResetOverride} />
        {variableRef && ctl ? (
          <LegacyVariableBoundPill
            property="transition"
            propertyLabel="Transition"
            variableRef={variableRef}
            currentValue={JSON.stringify(currentTransition)}
            removeVariable={handleRemoveVariable}
          />
        ) : (
          <ControlActionRow onClick={() => setIsOpen(true)}>
            <TransitionCurveIcon isSpring={isSpring} />
            <span className="truncate flex-1">{summary}</span>
          </ControlActionRow>
        )}
      </div>
      <ToolPopup isOpen={isOpen} onClose={() => setIsOpen(false)} title="Transition" anchorRef={btnRef} width={280}>
        <TransitionPanel initialTransition={currentTransition} onWrite={handleWrite} />
      </ToolPopup>
    </>
  );
}
