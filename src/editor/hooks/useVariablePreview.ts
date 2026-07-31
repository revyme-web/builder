// useVariablePreview — shared LIVE (per-frame, imperative) preview of a page/template VARIABLE's value.
//
// When the user drags a control bound to a variable (color/slider/border-width/…) in the Template tool OR
// the variable modal's Default editor, we must NOT commit code + re-parse every frame (that's the slow-fps
// bottleneck). Instead we compute, ONCE, which canvas nodes consume each variable + on which viewport tiles,
// then patch the canvas DOM DIRECTLY per frame via the bridge. Code is committed once on pointer-up (setVar).
//
// Extracted from TemplatePicker so BOTH surfaces share one implementation (the binding computation is subtle:
// viewport-aware base-vs-per-viewport bands, hoisted-into-instance props, layout:: prefixing).
import { useCallback, useMemo } from 'react';
import { useAtomValue } from 'jotai';
import { nodesAtom } from '@/code/stores/store';
import { viewportsConfigAtom } from '@/code/stores/viewport-store';
import { projectVersionAtom, projectFS } from '@/code/project/project-fs';
import { getContentRoot, patchNodeStyles } from '@/canvas/node-ops';
import { bandForTile } from '@/canvas/resolve-core';
import { parseJSXToNodes } from '@/code/parsing/parser';
import { resolveInstancePropOverrides } from '@/code/parsing/project-parser';
import { extractImports, resolveImportPath } from '@/code/components/import-resolver';
import { trace } from '@/shared/debug-trace';

type VarBinding = { id: string; cssProp: string | null; vpPrefixes: string[]; isText: boolean };
type HoistedBinding = { id: string; cssProp: string; vpPrefixes: string[] };

/**
 * Compute variable→bound-node maps for `clientPath` (the file whose instances carry hoisted props) and
 * return a `previewVar(name, value)` that imperatively patches every consuming canvas tile — no code write.
 */
export function useVariablePreview(clientPath: string | null | undefined) {
  const nodes = useAtomValue(nodesAtom);
  const viewportsConfig = useAtomValue(viewportsConfigAtom);
  const projectVersion = useAtomValue(projectVersionAtom);

  const varBoundNodes = useMemo(() => {
    // Each binding records the VIEWPORT PREFIXES it actually applies to (viewport-aware live patch):
    //  • BASE style binding (`styleVariables`) → the tiles NOT covered by a per-viewport override of
    //    that prop (so dragging color3/Desktop doesn't repaint the Tablet tile that uses color5).
    //  • PER-VIEWPORT binding (`responsiveStyleVariables[prop][W]`, band [minW,W]) → only the tiles
    //    inside that band (so dragging color5 live-updates the Tablet tile — was missed before).
    const map = new Map<string, VarBinding[]>();
    const prefOf = (vp: { id: string; isPrimary?: boolean }) => (vp.isPrimary ? '' : `${vp.id}-`);
    const allPrefixes = viewportsConfig.map(prefOf);
    const push = (varName: string, e: VarBinding) => {
      if (!varName || e.vpPrefixes.length === 0) return;
      let arr = map.get(varName);
      if (!arr) { arr = []; map.set(varName, arr); }
      arr.push(e);
    };
    for (const [id, node] of nodes) {
      if (node.styleVariables) {
        for (const [cssProp, varN] of Object.entries(node.styleVariables)) {
          if (!varN) continue;
          const rsv = node.responsiveStyleVariables?.[cssProp];
          const bands = node.responsiveStyleBands?.[cssProp];
          const coveredWidths = rsv ? Object.keys(rsv).map(Number) : [];
          const vpPrefixes = viewportsConfig
            .filter((vp) => !coveredWidths.some((W) => vp.width <= W && vp.width >= (bands?.[W] ?? 0)))
            .map(prefOf);
          push(varN, { id, cssProp, vpPrefixes, isText: false });
        }
      }
      if (node.responsiveStyleVariables) {
        for (const [cssProp, byW] of Object.entries(node.responsiveStyleVariables)) {
          const bands = node.responsiveStyleBands?.[cssProp];
          for (const [wStr, varN] of Object.entries(byW)) {
            if (!varN) continue;
            const W = Number(wStr);
            // A tile belongs to breakpoint W ONLY if W is the band the RENDERER resolves for it
            // (first-match-wins via bandForTile) — NOT every band whose range covers it.
            const vpPrefixes = viewportsConfig.filter((vp) => bandForTile(byW, bands, vp.width) === W).map(prefOf);
            push(varN, { id, cssProp, vpPrefixes, isText: false });
          }
        }
      }
      if (node.textVariable) push(node.textVariable, { id, cssProp: null, vpPrefixes: allPrefixes, isText: true });
    }
    return map;
  }, [nodes, viewportsConfig]);

  // HOISTED vars: a template var passed INTO a component instance (`<Frame color={myVar}/>`). Its live value
  // lives on the instance's EXPANDED INTERNAL node, not a direct layout-node style — so `varBoundNodes` misses
  // it. Map `templateVar → { expandedNodeId, cssProp }` via the instance's `attrPropRefs` + the component's own
  // prop→CSS mapping (resolveInstancePropOverrides). Parse the client RAW (unexpanded) so the instance keeps
  // its attrPropRefs + tag. Expanded ids on a page are `layout::<instanceId>:<internalId>`.
  const hoistedBoundNodes = useMemo(() => {
    const map = new Map<string, HoistedBinding[]>();
    const prefOf = (vp: { id: string; isPrimary?: boolean }) => (vp.isPrimary ? '' : `${vp.id}-`);
    if (!clientPath) return map;
    const code = projectFS.readFile(clientPath);
    if (!code) return map;
    try {
      const raw = parseJSXToNodes(code);
      const imports = extractImports(code);
      // Per-component cache: prop name → { cssProp, nodeId } for props used in a PER-VARIANT style ternary.
      const compVariantProps = new Map<string, Map<string, { cssProp: string; nodeId: string }>>();
      const getVariantProps = (compPath: string, compCode: string) => {
        let m = compVariantProps.get(compPath);
        if (m) return m;
        m = new Map<string, { cssProp: string; nodeId: string }>();
        try {
          for (const cn of parseJSXToNodes(compCode).values()) {
            // Per-variant TERNARY variable (`cssProp: variant === 'v' ? prop : base` → conditionalStyleVariables,
            // keyed [cssProp][variant] = prop).
            if (cn.conditionalStyleVariables) {
              for (const [cssProp, byVariant] of Object.entries(cn.conditionalStyleVariables)) {
                for (const pn of Object.values(byVariant)) m.set(pn, { cssProp, nodeId: cn.id });
              }
            }
            // VARIANT-OBJECT variable (`logoNameVariants['v'] = { color: prop }` → motionVariantVariables, keyed
            // [variant][cssProp] = prop). Without this the live color preview missed `color2`-style vars (the
            // logo color drag only updated on COMMIT, not per-frame) — map prop → its cssProp + node here too.
            if (cn.motionVariantVariables) {
              for (const byCss of Object.values(cn.motionVariantVariables)) {
                for (const [cssProp, pn] of Object.entries(byCss)) m.set(pn, { cssProp, nodeId: cn.id });
              }
            }
          }
        } catch { /* parse error while typing — leave empty */ }
        compVariantProps.set(compPath, m);
        return m;
      };
      for (const [id, node] of raw) {
        if (!node.attrPropRefs && !node.responsiveAttrPropVariables) continue;
        const importSrc = imports.get(node.type);
        const compPath = importSrc ? resolveImportPath(importSrc, clientPath) : null;
        const compCode = compPath ? projectFS.readFile(compPath) : null;
        if (!compCode || !compPath) continue;
        const variantProps = getVariantProps(compPath, compCode);
        const targetsFor = (prop: string): Array<{ nodeId: string; cssProp: string }> => {
          const out: Array<{ nodeId: string; cssProp: string }> = [];
          const overrides = resolveInstancePropOverrides({ [prop]: '__probe__' }, compCode);
          for (const ov of overrides.values()) if (ov.kind === 'style') out.push({ nodeId: ov.nodeId, cssProp: ov.cssProp });
          const vp = variantProps.get(prop);
          if (vp) out.push({ nodeId: vp.nodeId, cssProp: vp.cssProp });
          return out;
        };
        const push = (varName: string, nodeId: string, cssProp: string, vpPrefixes: string[]) => {
          if (!varName || vpPrefixes.length === 0) return;
          let arr = map.get(varName);
          if (!arr) { arr = []; map.set(varName, arr); }
          arr.push({ id: `layout::${id}:${nodeId}`, cssProp, vpPrefixes });
        };
        // Per-viewport LITERAL prop overrides on this instance (`data-responsive={"768":{"radius1":"0px"}}`):
        // map prop → the widths where it shows a FIXED value (not the variable). Parsed once per node.
        const litOverridesByProp: Record<string, number[]> = {};
        try {
          const resp = node.attrs?.['data-responsive'] ? JSON.parse(node.attrs['data-responsive']) : null;
          if (resp) {
            for (const k of Object.keys(resp)) {
              if (k === '_bp' || !resp[k] || typeof resp[k] !== 'object') continue;
              const w = Number(k);
              if (Number.isNaN(w)) continue;
              for (const p of Object.keys(resp[k])) (litOverridesByProp[p] ??= []).push(w);
            }
          }
        } catch { /* malformed → no literal exclusions */ }
        // BASE bindings → the tiles NOT covered by a per-viewport band OR a per-viewport LITERAL override of that
        // prop. The literal-override tile renders a fixed value, not the variable, so the live drag must NOT patch
        // it (the reported "tablet matched the radius during drag, reverted on mouseup" bug).
        for (const [prop, refName] of Object.entries(node.attrPropRefs ?? {})) {
          const byW = node.responsiveAttrPropVariables?.[prop];
          const bands = node.responsiveAttrPropBands?.[prop];
          const coveredWidths = byW ? Object.keys(byW).map(Number) : [];
          const litWidths = litOverridesByProp[prop] ?? [];
          const vpPrefixes = viewportsConfig
            .filter((vp) => !coveredWidths.some((W) => vp.width <= W && vp.width >= (bands?.[W] ?? 0)))
            .filter((vp) => !litWidths.includes(vp.width))
            .map(prefOf);
          for (const t of targetsFor(prop)) push(refName, t.nodeId, t.cssProp, vpPrefixes);
        }
        // PER-VIEWPORT bindings → only the band's tiles.
        for (const [prop, byW] of Object.entries(node.responsiveAttrPropVariables ?? {})) {
          const bands = node.responsiveAttrPropBands?.[prop];
          for (const [wStr, branchVar] of Object.entries(byW)) {
            const W = Number(wStr);
            const vpPrefixes = viewportsConfig.filter((vp) => bandForTile(byW, bands, vp.width) === W).map(prefOf);
            for (const t of targetsFor(prop)) push(branchVar, t.nodeId, t.cssProp, vpPrefixes);
          }
        }
      }
    } catch (e) {
      trace.error('use-variable-preview:hoisted-bound-nodes-failed', e);
    }
    return map;
  }, [clientPath, projectVersion, viewportsConfig]);

  const previewVar = useCallback((name: string, value: string) => {
    const contentEl = getContentRoot();
    if (!contentEl) return;
    // Direct style/text bindings — patch ONLY each binding's own applicable tiles (viewport-aware).
    const hoisted = hoistedBoundNodes.get(name);
    const hoistedIds = new Set((hoisted ?? []).map((h) => h.id));
    const binds = varBoundNodes.get(name);
    if (binds) {
      for (const b of binds) {
        if (hoistedIds.has(b.id)) continue; // viewport-aware hoisted patch owns this node — don't all-tiles it
        for (const p of b.vpPrefixes) {
          if (b.isText) {
            const el = contentEl.querySelector(`[data-node-id="${p}${b.id}"]`) as HTMLElement | null;
            if (el) el.textContent = value;
          } else if (b.cssProp) {
            patchNodeStyles(contentEl, b.id, p, { [b.cssProp]: value });
          }
        }
      }
    }
    // Hoisted bindings: patch the instance's expanded internal node(s) ONLY on the tiles this binding applies to.
    if (hoisted) {
      trace.action('use-variable-preview:preview-hoisted', { name, value, bindings: hoisted.map((h) => ({ id: h.id, cssProp: h.cssProp, vpPrefixes: h.vpPrefixes })) });
      for (const h of hoisted) {
        for (const p of h.vpPrefixes) patchNodeStyles(contentEl, h.id, p, { [h.cssProp]: value });
      }
    }
  }, [varBoundNodes, hoistedBoundNodes]);

  return { previewVar, varBoundNodes, hoistedBoundNodes };
}
