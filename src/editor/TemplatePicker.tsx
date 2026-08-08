// TemplatePicker.tsx — Right-panel section for assigning a Template to a page.
//
// Renders as a standard tool section (`ToolSection` + `ToolSelect` +
// `ToolButton`) so it sits flush with Position / Dimensions / Layout.
// Visible whenever the active file is a page (`app/.../page.tsx`).
//
// Two modes:
//   - **No template assigned**: section header only, `+` action opens
//     the New Template modal (creates AND auto-applies). The body is
//     empty because there's nothing to configure. Same shape as
//     LayoutTool's empty state.
//   - **Template assigned**: header shows `-` (removes the template,
//     reverting to the empty state). Body shows a Layout select listing
//     every available template (no "None" — removal goes through the
//     `-` action) plus an Edit button to open the template's
//     LayoutClient.tsx.

import { useCallback, useMemo, useRef, useState } from 'react';
import { useAtomValue, useSetAtom, useAtom } from 'jotai';
import { activeFilePathAtom, switchActiveFile, componentBreadcrumbAtom, filePathToSlug, getVariantBasePage, setVariantTemplate } from '@/code/project/active-file-store';
import { selectedIdsAtom, updatingFromCanvasAtom } from '@/code/stores/store';
import { useVariablePreview } from '@/editor/hooks/useVariablePreview';
import { projectVersionAtom, projectFS } from '@/code/project/project-fs';
import {
  listTemplates,
  getPageTemplate,
  assignTemplate,
  createTemplate,
  validateTemplateName,
} from '@/code/project/template-ops';
import { toast } from 'sonner';
import { parseComponentInfoFromSource, STRUCTURAL_PROPS, type ComponentProp } from '@/code/components/component-registry';
import { getPropOptions } from '@/code/components/prop-meta';
import { parseJSXToNodes } from '@/code/parsing/parser';
import { extractImports, resolveImportPath } from '@/code/components/import-resolver';
import { ComponentCursorEditor } from './tools/CursorTool';
import { detectPropAsVariantBinding } from './tools/ComponentPropsTool';
import { parseComponentCursorCalls } from '@/code/parsing/cursor-parser';
import { updateComponentCursorInCode, ensureDefaultImportInCode, type AddComponentCursorOpts } from '@/code/generation/cursor-gen';
import { setComponentPropDefaultInCode } from '@/code/features/variable-ops';
import { getComponentDisplayName } from '@/code/components/component-ops';
import { ControlActionRow } from './controls';
import ToolPopup from './ui/ToolPopup';
import { setTemplateRouteValueInCode, getTemplateRouteValues } from '@/code/generation/template-route-gen';
import { getScrollVariant } from '@/code/generation/scroll-variant-gen';
import { parseVariantConfig, selectableVariants } from '@/code/variants/variant-config';
import { modifyProjectFile } from '@/code/project/modify-file';
import { getAnchorsForPage } from '@/editor/tools/LinkTool/LinkUrlControl';
import { flushNow, syncQueueCode } from '@/code/mutation/mutation-queue';
import { sealPendingHistory, pushHistoryFileOp } from '@/code/mutation/history';
import { forceCanvasRender } from '@/canvas/node-ops';
import { ToolSection, ToolSelect, ToolButton, ToolRow, ToolInput, ToolSegmentedControl, ToolDivider, ColorInput } from './controls';
import { LabelOverrideProvider } from './controls/label-override-context';

// Atoms whose editor is a vertically-STACKING EntryList (multiple rows + Add) — Shadow / Filter / Mask.
// In the Template tool these must render FULL-WIDTH with the label ABOVE (like the variable modal), not in
// the horizontal label|value ToolRow, or the stacked entries overflow sideways.
const MULTI_ROW_DRIVEN_PROPS = new Set(['boxShadow', 'filter', 'backdropFilter', 'maskImage', '-webkit-mask-image']);
import { resolveControl } from './controls/control-registry';
import { resolveVariableEditor } from './controls/variable-editor-registry';
import { resolveVariableCssProp, isVariableAppliedInCode, type ChildResolution } from '@/code/components/prop-css-mapping';
import { UnifiedControlProvider } from './controls/unified';
import { LinkUrlField } from './tools/LinkTool/LinkUrlControl';
import NameInputModal from '@/editor/ui/NameInputModal';
import { trace } from '@/shared/debug-trace';

/**
 * Template-tool row for a hoisted COMPONENT cursor variable. Renders the SAME full Component Cursor popup the
 * instance editor uses (`ComponentCursorEditor`), but routes its writes for the TEMPLATE:
 *   - **Component** → the template's param default for the variable (`cursorVar = Pointer`, an imported
 *     identifier) — NOT the instance prop, which holds `={cursorVar}` (writing there would unbind the variable).
 *   - **Behaviour** (mode/size/transition/…) → the master's `withCursor(prop, { … })`, same as the instance row.
 * The consuming instance + master file + cursor prop name are resolved from the `someCursor={cursorVar}` binding.
 */
function TemplateCursorRow({ varName, label, templateCode, clientPath, currentDefault, onChanged }: {
  varName: string; label: string; templateCode: string; clientPath: string; currentDefault: string; onChanged: () => void;
}) {
  const btnRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  // The instance forwarding this variable: `<Inst someCursor={varName}>` → its id, tag, and the cursor prop.
  const binding = useMemo(() => {
    try {
      for (const n of parseJSXToNodes(templateCode).values()) {
        const refs = (n as { attrPropRefs?: Record<string, string> }).attrPropRefs;
        if (!refs) continue;
        for (const [prop, ref] of Object.entries(refs)) {
          if (ref === varName) return { instanceNodeId: n.id, instanceComponentName: n.type, propName: prop };
        }
      }
    } catch { /* parse error while typing */ }
    return null;
  }, [templateCode, varName]);

  const masterFile = useMemo(() => {
    if (!binding) return null;
    const spec = extractImports(templateCode).get(binding.instanceComponentName);
    return spec ? resolveImportPath(spec, clientPath) : null;
  }, [binding, templateCode, clientPath]);

  // The master's withCursor(prop, …) call — seeds the behaviour controls + is the write target for them.
  const masterCursor = useMemo(() => {
    if (!masterFile || !binding) return null;
    const cc = projectFS.readFile(masterFile);
    return cc ? (parseComponentCursorCalls(cc).find((c) => c.componentName === binding.propName) ?? null) : null;
  }, [masterFile, binding]);

  // The currently-picked cursor component = the template's param default identifier for the variable.
  const currentComponent = useMemo(() => {
    if (currentDefault && /^[A-Z]/.test(currentDefault)) return currentDefault;
    const m = templateCode.match(new RegExp(`\\b${varName}\\s*=\\s*([A-Z]\\w*)`));
    return m ? m[1] : '';
  }, [currentDefault, templateCode, varName]);

  const currentDisplay = currentComponent ? (getComponentDisplayName(`components/${currentComponent}.tsx`) ?? currentComponent) : 'Choose…';

  const handleWrite = useCallback((opts: AddComponentCursorOpts) => {
    // Component identity → the TEMPLATE's param default (identifier + import), keeping `={varName}` on the
    // instance intact. "Choose…" (empty) → clear back to an empty-string default.
    modifyProjectFile(clientPath, (c) => {
      let next = c;
      if (opts.componentName && opts.componentName !== varName) {
        if (opts.componentImportPath) next = ensureDefaultImportInCode(next, opts.componentName, opts.componentImportPath);
        next = setComponentPropDefaultInCode(next, varName, opts.componentName, 'identifier');
      } else if (!opts.componentName) {
        next = setComponentPropDefaultInCode(next, varName, '', 'string');
      }
      return next;
    });
    // Behaviour opts → the master's withCursor call (shared by every instance), same as the instance editor.
    if (masterCursor && masterFile && binding) {
      modifyProjectFile(masterFile, (cc) => updateComponentCursorInCode(cc, masterCursor.nodeId, {
        componentName: binding.propName,
        variant: opts.variant, mode: opts.mode, side: opts.side, align: opts.align,
        offsetX: opts.offsetX, offsetY: opts.offsetY, transition: opts.transition,
        width: opts.width, height: opts.height, enterExit: opts.enterExit,
      }));
    }
    onChanged();
    trace.action('template-cursor-row:write', { varName, component: opts.componentName, hasMasterCall: !!masterCursor });
  }, [clientPath, varName, masterCursor, masterFile, binding, onChanged]);

  return (
    <>
      {/* Value slot only — the caller's ToolRow already renders the variable name as the label. */}
      <div ref={btnRef} className="flex-1 min-w-0">
        <ControlActionRow onClick={() => setOpen(true)}>
          <span className="truncate flex-1 text-left">{currentDisplay}</span>
        </ControlActionRow>
      </div>
      {binding && (
        <ToolPopup isOpen={open} onClose={() => setOpen(false)} title="Component Cursor" anchorRef={btnRef} width={280}>
          <ComponentCursorEditor
            nodeId={binding.instanceNodeId}
            activeFile={clientPath}
            allowNoComponent
            initial={{
              componentName: currentComponent || '',
              variant: masterCursor?.variant,
              mode: masterCursor?.mode ?? 'follow',
              side: masterCursor?.side ?? 'bottom',
              align: masterCursor?.align ?? 'center',
              offsetX: masterCursor?.offsetX ?? 0,
              offsetY: masterCursor?.offsetY ?? 0,
              transition: masterCursor?.transition ?? { type: 'spring', stiffness: 300, damping: 30 },
              width: masterCursor?.width === undefined ? '0' : String(masterCursor.width),
              height: masterCursor?.height === undefined ? '0' : String(masterCursor.height),
              enterExit: masterCursor?.enterExit ?? false,
            }}
            onWrite={handleWrite}
          />
        </ToolPopup>
      )}
    </>
  );
}

export default function TemplatePicker() {
  const filePath = useAtomValue(activeFilePathAtom);
  const setActiveFile = useSetAtom(activeFilePathAtom);
  const [selectedIds, setSelectedIds] = useAtom(selectedIdsAtom);
  const setUpdatingFromCanvas = useSetAtom(updatingFromCanvasAtom);
  const setBreadcrumb = useSetAtom(componentBreadcrumbAtom);
  // Bump-on-write: assignTemplate moves files via projectFS, which doesn't
  // touch the React atom — we have to. Subscribing here keeps the
  // template list current after creates/renames/deletes elsewhere.
  const [projectVersion, setVersion] = useAtom(projectVersionAtom);

  const [createModalOpen, setCreateModalOpen] = useState(false);

  const templates = listTemplates();
  const currentTemplate = getPageTemplate(filePath);
  const currentTpl = templates.find(t => t.name === currentTemplate);

  // A/B-test variant: it lives outside the route-group tree, so the normal
  // assign/remove flow (which MOVES the file between `app/(group)/` dirs) can't
  // run — it'd yank the file out of `_revyme/variants/` and break the test.
  // Instead a variant stores its template choice in its manifest, so it can run
  // a DIFFERENT template than its Control. See setVariantTemplate.
  const isVariant = !!getVariantBasePage(filePath);
  // Sentinel for the "no template" choice in the variant Layout dropdown.
  const VARIANT_NONE = ' none';

  // ── Template VARIABLES (the headline of the Template tool) ──────────────────
  // A template (LayoutClient) is a design-component master: its function params
  // (+ @propMeta) ARE its variables. Surface them here so each page sets its own
  // values — exactly like the component-instance props tool, but the values are
  // stored per-page in the page's `@templateProps` annotation (a template has no
  // instance tag). Reuses the registry's source parser; templates aren't in
  // `components/` so we parse the LayoutClient directly.
  const { templateVars, templateCode } = useMemo(() => {
    if (!currentTpl) return { templateVars: [] as ComponentProp[], templateCode: '' };
    const code = projectFS.readFile(currentTpl.clientPath) ?? '';
    const info = code ? parseComponentInfoFromSource(currentTpl.clientPath, code, String(code.length)) : null;
    const vars = info ? info.props.filter(p => !STRUCTURAL_PROPS.has(p.name)) : [];
    return { templateVars: vars, templateCode: code };
  }, [currentTpl?.clientPath, projectVersion]);

  // This page's URL path — the route-map KEY (what usePathname() returns at
  // runtime). Home ('home' slug) → '/', everything else → '/<slug>'.
  // A variant shares its parent page's URL, so resolve through the base page
  // — its template-variable values come from the same route entry as the page.
  const pageRoute = useMemo(() => {
    const slug = filePathToSlug(getVariantBasePage(filePath) ?? filePath);
    return slug === 'home' ? '/' : `/${slug}`;
  }, [filePath]);

  // Per-page overrides come from the NATIVE route map inside the template's
  // LayoutClient (not a page comment) — the same map usePathname() reads at
  // runtime. Page's own anchors feed `section` vars.
  const pageTemplateProps = useMemo(() => {
    if (!currentTpl) return {};
    const code = projectFS.readFile(currentTpl.clientPath);
    return code ? getTemplateRouteValues(code, pageRoute) : {};
  }, [currentTpl?.clientPath, pageRoute, projectVersion]);
  const pageAnchors = useMemo(() => getAnchorsForPage(filePath), [filePath, projectVersion]);

  // Write one template-variable value for THIS page's route into the
  // LayoutClient's native route map (empty clears → falls back to the param
  // default). NATIVE: usePathname() resolves it in deploy + the React preview;
  // the canvas store.ts merge reads the same map. The reassignment block lists
  // ALL template vars so it stays complete.
  const setVar = useCallback((name: string, value: string) => {
    if (!currentTpl) return;
    const allVars = templateVars.map((v) => v.name);
    modifyProjectFile(currentTpl.clientPath, code => setTemplateRouteValueInCode(code, pageRoute, name, value, allVars));
    setVersion(v => v + 1);
    // FULL canvas rebuild after the reparse lands. A template var that drives a STYLE inside a component
    // instance (e.g. `color: variant === 'v6' ? color : '#000'` on the Header's logo) changes the resolved
    // value WITHOUT changing the instance's variant — so the Renderer's in-place `patchElement` (which only
    // re-resolves variant styles when the VARIANT changes) keeps the stale color and the commit appears to
    // "revert" (the live drag-preview clears, nothing replaces it). A VARIANT template var doesn't hit this
    // (the variant change forces re-resolution). rAF lets projectVersion's reparse produce the new node map
    // first, then forces the rebuild that actually paints it. Mirrors the pagination/SizeTool forced-render.
    requestAnimationFrame(() => forceCanvasRender());
    trace.action('template-picker:set-var', { route: pageRoute, clientPath: currentTpl.clientPath, name });
  }, [currentTpl, pageRoute, templateVars, setVersion]);

  // ── 60fps LIVE PREVIEW (color-picker drag etc.) ─────────────────────────────
  // Committing code on every drag frame (setVar → modifyProjectFile → reparse →
  // re-merge → full re-render) tanks FPS. Mirror the component-instance fix:
  // map each template var to the merged `layout::` nodes that bind it (the
  // parser records `styleVariables`/`textVariable` on the LayoutClient's nodes,
  // and the layout-merge keeps them), then patch the canvas DOM DIRECTLY per
  // frame via the bridge. Code is committed once on pointer-up (`setVar`).
  // LIVE per-frame preview of a variable's value (imperative bridge patch, no code write) + the
  // variable→bound-node maps used below for control derivation. Extracted to a shared hook so the
  // variable modal's Default editor gets the SAME smooth drag (see useVariablePreview).
  const { previewVar, varBoundNodes, hoistedBoundNodes } = useVariablePreview(currentTpl?.clientPath);

  // A TRANSITION var has no live DOM preview (it only governs animation timing, nothing visual changes per
  // frame), AND its panel commits CONTINUOUSLY (no pointer-up event) — so writing + reparsing this (large)
  // template file on every slider frame tanks FPS. Debounce so only the settled value commits to code.
  const txCommitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const setVarDebounced = useCallback((name: string, value: string) => {
    if (txCommitTimer.current) clearTimeout(txCommitTimer.current);
    txCommitTimer.current = setTimeout(() => setVar(name, value), 140);
  }, [setVar]);


  // VARIANT variables: a template var that drives a component instance's
  // VARIANT — bound either directly (`<Header initialVariant={headerVar}/>`) or
  // as the resting/start variant of a scroll-variant effect (`fromVar`). Resolve
  // the instance's component → its variant list so the Template panel renders a
  // variant SELECT (the component's variants) instead of a bare text input —
  // matching the variant SELECT the VariableModal shows at create time.
  // Mirrors `hoistedBoundNodes`: parse the LayoutClient RAW (unexpanded) so each
  // instance keeps its tag + attrPropRefs, then resolve its import → component.
  const variantVarOptions = useMemo(() => {
    const map = new Map<string, Array<{ value: string; label: string }>>();
    if (!currentTpl) return map;
    const code = projectFS.readFile(currentTpl.clientPath);
    if (!code) return map;
    const tplVarNames = new Set(templateVars.map((v) => v.name));
    try {
      const raw = parseJSXToNodes(code);
      const imports = extractImports(code);
      for (const [id, node] of raw) {
        // Which template var(s) drive this instance's variant? Collect EVERY binding so a
        // PER-VIEWPORT variant variable gets the select too, not just the base:
        //   • the scroll-variant base resting var (`spec.fromVar`),
        //   • each per-viewport resting var (`spec.responsive[scope].fromVar`; '' = the
        //     cascade-broken sentinel → skipped),
        //   • else a direct `initialVariant={someTemplateVar}` binding.
        const sv = getScrollVariant(code, id);
        const varNames = new Set<string>();
        if (sv) {
          if (sv.fromVar) varNames.add(sv.fromVar);
          for (const r of (sv.responsive ?? [])) {
            if (r.fromVar) varNames.add(r.fromVar);
          }
        }
        if (varNames.size === 0) {
          const direct = node.attrPropRefs?.['initialVariant'];
          if (direct && tplVarNames.has(direct)) varNames.add(direct);
        }
        // PER-VIEWPORT variant variable (the inline `initialVariant={__mqN ? var : base}` rail on a
        // replica) lives in responsiveAttrPropVariables, NOT attrPropRefs — collect every branch var so
        // a variant variable hoisted on a replica gets the variant SELECT too (not a bare text input).
        const vpVariantVars = node.responsiveAttrPropVariables?.['initialVariant'];
        if (vpVariantVars) {
          for (const v of Object.values(vpVariantVars)) if (tplVarNames.has(v)) varNames.add(v);
        }
        if (varNames.size === 0) continue;
        // Resolve the instance's component → its variant list (once per instance), then map
        // EACH bound variable to it.
        const importSrc = imports.get(node.type);
        const compPath = importSrc ? resolveImportPath(importSrc, currentTpl.clientPath) : null;
        const compCode = compPath ? projectFS.readFile(compPath) : null;
        if (!compCode) continue;
        // REAL variants only — never list interaction states (hover/pressed) as selectable choices.
        const variants = selectableVariants(parseVariantConfig(compCode));
        if (variants.length === 0) continue;
        const opts = variants.map((v) => ({ value: v.name, label: v.label || v.name }));
        for (const varName of varNames) {
          if (!map.has(varName)) map.set(varName, opts);
        }
        trace.action('template-picker:variant-vars-detected', { vars: [...varNames], component: node.type, count: variants.length });
      }
      // FORWARDED template vars — a var passed into a child's NON-initialVariant prop drives a variant
      // DEEPER (`<Header baPoWeVariant={baPoWeVariant}>` → inside Header → Logo Mark). The loop above only
      // sees DIRECT initialVariant bindings; detectPropAsVariantBinding (AST + forwarded recursion) follows
      // the chain to the deepest component's variants.
      for (const tv of templateVars) {
        if (map.has(tv.name)) continue;
        const childFile = detectPropAsVariantBinding(tv.name, code, currentTpl.clientPath);
        if (!childFile) continue;
        const childCode = projectFS.readFile(childFile);
        if (!childCode) continue;
        const variants = selectableVariants(parseVariantConfig(childCode));
        if (variants.length > 0) map.set(tv.name, variants.map((vr) => ({ value: vr.name, label: vr.label || vr.name })));
      }
    } catch (e) {
      trace.error('template-picker:variant-var-options-failed', e);
    }
    return map;
  }, [currentTpl?.clientPath, projectVersion, templateVars]);

  /** Move the current page into a template (or out, when name is null).
   *  Path-only move. Bumps the version atom so the canvas re-renders
   *  against the new layout merge. Used by the Layout select, the
   *  create-and-apply flow, and the section's `-` action.
   *  Returns the page's path after the move (unchanged when blocked) so the
   *  create flow can chain navigation + history off it. */
  const applyTemplate = useCallback((templateName: string | null): string => {
    // Hard guard: never move an A/B variant between route groups (it would
    // leave `_revyme/variants/` and break the test). The UI is read-only for
    // variants; this backstops any programmatic caller.
    if (isVariant) return filePath;
    if (templateName === currentTemplate) return filePath;
    flushNow();
    // The move bypasses the mutation queue — seal pending edits as their own
    // entry so this operation doesn't merge into them (see pushHistoryFileOp).
    sealPendingHistory();
    const newPath = assignTemplate(filePath, templateName);
    if (newPath !== filePath) {
      setActiveFile(newPath);
      setVersion(v => v + 1);
      // Selection survival across the move: the merged viewport frame is
      // ALWAYS `'root'` now. Assigning a template merges the template root
      // ONTO the page root — it TAKES OVER the id `'root'` (the "Root↔template
      // merge"); removing one reverts to the bare page `'root'`. There is NO
      // separate `'layout::root'` node post-merge (store.ts merge; asserted by
      // store.test.ts "no separate layout::root ghost layer exists"). The old
      // code re-anchored an ASSIGN to `'layout::root'`, which pointed the
      // selection at a NON-EXISTENT node — leaving the properties panel blank
      // and selection-dependent UI broken right after applying a template to a
      // page. Always re-anchor to `'root'`.
      const wasViewportSelection =
        selectedIds.length === 1 && (selectedIds[0] === 'root' || selectedIds[0] === 'layout::root');
      if (wasViewportSelection) {
        setSelectedIds(['root']);
      }
      // ONE history entry for the assignment (an FS move the queue never
      // sees). Undo lands on the page's PRE-move path — the post-move path
      // doesn't exist in the restored state.
      pushHistoryFileOp(filePath);
      trace.action('template-picker:switched', { from: filePath, to: newPath, templateName });
    }
    return newPath;
  }, [isVariant, currentTemplate, filePath, selectedIds, setActiveFile, setSelectedIds, setVersion]);

  const handlePick = useCallback((value: string) => {
    applyTemplate(value);
  }, [applyTemplate]);

  /** Per-variant template switch — writes the choice into the variant's
   *  manifest (no file move) and re-merges. `VARIANT_NONE` → no template. */
  const handleVariantPick = useCallback((value: string) => {
    flushNow();
    const templateName = value === VARIANT_NONE ? '' : value;
    setVariantTemplate(filePath, templateName);
    setVersion(v => v + 1);
    // Selection survival: the merged viewport frame is ALWAYS `'root'` (the
    // template root takes over `'root'`; there's no `'layout::root'` node) —
    // re-anchor there so the panel doesn't point at a dead id after the
    // template changes underneath the selection. (See applyTemplate above.)
    const wasViewportSelection =
      selectedIds.length === 1 && (selectedIds[0] === 'root' || selectedIds[0] === 'layout::root');
    if (wasViewportSelection) setSelectedIds(['root']);
    trace.action('template-picker:variant-template', { variant: filePath, template: templateName || '(none)' });
  }, [filePath, selectedIds, setSelectedIds, setVersion]);

  const handleCreateAndApply = useCallback((name: string) => {
    setCreateModalOpen(false);
    flushNow();
    // Seal pending edits BEFORE the create — the whole create+apply lands as
    // ONE dedicated history entry (see pushHistoryFileOp in applyTemplate),
    // never merged into whatever the user edited just before.
    sealPendingHistory();
    // Reject silently when the name is invalid or already in use; the
    // modal closes either way and the user can retry. (Inline validation
    // belongs in NameInputModal — separate UX work.)
    const clientPath = createTemplate(name);
    if (!clientPath) {
      // `validate` refuses every known-bad name inline; reaching here means it
      // became unavailable between keystroke and submit. Tell the user.
      trace.error('template-picker:create-failed', { name });
      toast.error(validateTemplateName(name) ?? `Couldn't create the template "${name}"`);
      return;
    }
    setVersion(v => v + 1);
    // ONE source for the created name: parse it from the path createTemplate
    // returned. The old local re-clean (`toLowerCase() + dash-join`) used
    // DIFFERENT rules than the op's sanitizer (which preserves case) — for
    // "Body" it looked up `app/(body)/` on a case-sensitive FS, found
    // nothing, and silently skipped the whole apply step: the template
    // appeared in the library but the page never got it (user report
    // 2026-07-27).
    const createdName = clientPath.match(/^app\/\(([^)]+)\)\//)?.[1];
    if (!createdName) {
      trace.error('template-picker:create-name-unparseable', { clientPath });
      return;
    }
    // Apply to THIS page (moves it into the group, records history), then
    // open the template itself for editing — creating from the tool means
    // "design this page's template now"; landing back on a visually
    // unchanged page read as "it did nothing".
    const newPagePath = applyTemplate(createdName);
    switchActiveFile(newPagePath, clientPath,
      { setActiveFile, setSelectedIds, setUpdatingFromCanvas },
      { syncQueueCode, flushNow },
    );
    // Breadcrumb back to the page it was created from (mirrors handleEdit).
    setBreadcrumb([newPagePath]);
    trace.action('template-picker:created-applied-editing', { name: createdName, page: newPagePath, clientPath });
  }, [applyTemplate, setVersion, setActiveFile, setSelectedIds, setUpdatingFromCanvas, setBreadcrumb]);

  const handleEdit = useCallback(() => {
    if (!currentTemplate) return;
    const tpl = templates.find(t => t.name === currentTemplate);
    if (!tpl) return;
    // Edit is a real navigation (page → layout file) — clear selection
    // because the layout's nodes are entirely different elements.
    switchActiveFile(filePath, tpl.clientPath,
      { setActiveFile, setSelectedIds, setUpdatingFromCanvas },
      { syncQueueCode, flushNow },
    );
    // Seed the breadcrumb with the originating page so the master breadcrumb
    // shows "<page> › <Template>" and "‹ back" returns here (mirrors how a
    // component double-click entry pushes the page it came from).
    setBreadcrumb([filePath]);
    trace.action('template-picker:edit', { template: currentTemplate, path: tpl.clientPath });
  }, [currentTemplate, templates, filePath, setActiveFile, setSelectedIds, setUpdatingFromCanvas]);

  // Layout select options — every template the project knows about.
  // No "None" pseudo-entry: removal goes through the `-` action so the
  // dropdown only ever surfaces real choices. If the page is in a route
  // group with no LayoutClient (stale state — template was deleted but
  // the page is still in its folder), surface that name so the user can
  // see the assignment and move out via `-`.
  const options: Array<{ value: string; label: string }> = templates.map(t => ({
    value: t.name, label: t.name,
  }));
  if (currentTemplate && !templates.some(t => t.name === currentTemplate)) {
    options.push({ value: currentTemplate, label: `${currentTemplate} (no layout)` });
  }

  const hasTemplate = !!currentTemplate;
  const editDisabled = !currentTemplate || !templates.some(t => t.name === currentTemplate);
  const hasAnyTemplate = templates.length > 0;

  const [pickerOpen, setPickerOpen] = useState(false);

  // Section header action:
  //   - `-` (template assigned): unassigns the template
  //   - `+` (no template, none exist anywhere): opens New Template modal directly
  //   - `+` (no template, some exist): opens dropdown listing existing templates
  //     + a "New Template…" entry — matches the AnimationTool / StylesTool
  //     AddEffectDropdown pattern so users can pick an existing template
  //     instead of being forced to create one.
  const toggleAction = hasTemplate ? (
    <button
      onClick={(e) => { e.stopPropagation(); applyTemplate(null); }}
      className="flex items-center justify-end pl-[80px] -ml-[80px] cursor-pointer group text-[var(--text-primary)]"
      title="Remove Template"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="transition-opacity group-hover:opacity-80">
        <line x1="5" y1="12" x2="19" y2="12" />
      </svg>
    </button>
  ) : (
    <div className="relative">
      <button
        onClick={(e) => {
          e.stopPropagation();
          if (hasAnyTemplate) {
            setPickerOpen(o => !o);
            trace.action('template-picker:toggle-picker', { open: !pickerOpen });
          } else {
            setCreateModalOpen(true);
          }
        }}
        className="flex items-center justify-end pl-[80px] -ml-[80px] cursor-pointer group text-[var(--text-primary)]"
        title={hasAnyTemplate ? 'Add Template' : 'New Template'}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="transition-opacity group-hover:opacity-80">
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </button>

      {pickerOpen && hasAnyTemplate && (
        <>
          <div className="fixed inset-0 z-[10000]" onClick={() => setPickerOpen(false)} />
          <div className="absolute right-0 top-full mt-1 bg-[var(--dropdown-bg)] shadow-[var(--shadow-lg)] rounded-[var(--radius-md)] py-1.5 z-[10001] min-w-44 border border-[var(--border-light)] space-y-0.5">
            {templates.map(tpl => (
              <button
                key={tpl.name}
                onClick={() => {
                  setPickerOpen(false);
                  applyTemplate(tpl.name);
                }}
                className="group flex items-center mx-1.5 px-2.5 py-1.5 rounded-[var(--radius-sm)] w-[calc(100%-12px)] text-left cursor-pointer hover:bg-[var(--accent)] transition-colors"
              >
                <span className="text-xs font-medium text-[var(--text-primary)] group-hover:text-[var(--accent-fg)]">
                  {tpl.name}
                </span>
              </button>
            ))}
            <button
              onClick={() => {
                setPickerOpen(false);
                setCreateModalOpen(true);
              }}
              className="group flex items-center mx-1.5 px-2.5 py-1.5 rounded-[var(--radius-sm)] w-[calc(100%-12px)] text-left cursor-pointer hover:bg-[var(--accent)] transition-colors"
            >
              <span className="text-xs font-medium text-[var(--text-primary)] group-hover:text-[var(--accent-fg)]">
                New Template…
              </span>
            </button>
          </div>
        </>
      )}
    </div>
  );

  // Resolve the cssProp a template variable ultimately drives — DIRECT layout-node style binding
  // (`varBoundNodes`), value HOISTED into a component-instance prop (`hoistedBoundNodes`), or the SHARED
  // resolver fallback (`resolveVariableCssProp`, incl. per-viewport + overlay custom-prop remap). Used both
  // to pick the editor atom AND (at the row level) to lay multi-row EntryList atoms full-width.
  const getDrivenProp = useCallback((prop: ComponentProp): string | undefined => {
    // A transition variable's control is ALWAYS the transition curve picker — its cssProp is 'transition'
    // regardless of how it threads through a component-instance prop (the cssProp resolver can't infer it from
    // a `transition1={transition1}` forward). Returning it here both marks the var "in use" (so the row shows)
    // AND resolves the editor atom (so it's the curve picker, not a raw text input).
    if (prop.varType === 'transition') return 'transition';
    const resolveChildCode = (childTag: string, parentCode: string, parentFilePath: string): ChildResolution | null => {
      const importSrc = extractImports(parentCode).get(childTag);
      const p = importSrc ? resolveImportPath(importSrc, parentFilePath) : null;
      const c = p ? projectFS.readFile(p) : null;
      return (p && c) ? { code: c, filePath: p } : null;
    };
    let dp = varBoundNodes.get(prop.name)?.find((b) => b.cssProp)?.cssProp
      ?? hoistedBoundNodes.get(prop.name)?.find((b) => b.cssProp)?.cssProp
      ?? (currentTpl ? (resolveVariableCssProp(prop.name, templateCode, currentTpl.clientPath, resolveChildCode) || undefined) : undefined);
    // A custom-property cssProp (`--border`) is the expansion write target, not a control — remap it to the
    // property the `::after` consumes it as (`border`) via the shared resolver.
    if (dp?.startsWith('--') && currentTpl) {
      dp = resolveVariableCssProp(prop.name, templateCode, currentTpl.clientPath, resolveChildCode) || dp;
    }
    return dp;
  }, [varBoundNodes, hoistedBoundNodes, currentTpl, templateCode]);

  // Only show variables ACTUALLY bound to something in the template — one that merely EXISTS (param +
  // @pageVariables, e.g. created then never attached, or unbound) clutters the tool. "In use" is decided by
  // a TEXTUAL scan of the TEMPLATE code only — NOT the parsed node model. Why textual: the model
  // (varBoundNodes/hoistedBoundNodes/getDrivenProp) includes the EXPANDED component-instance internals, whose
  // bindings reference the MASTER's OWN props. When a template variable shares a NAME with a master prop
  // (e.g. both `color`), the master's internal `color: color` made the model think the TEMPLATE's `color` was
  // used even after it was unbound from the instance — so an orphan stayed listed. `isVariableAppliedInCode`
  // runs on `templateCode` only, so the master internals are invisible to it (they live in the component file).
  // "In use" = applied in ANY binding form in the template (attr / forward / text / style value / call arg /
  // CSS var, via isVariableAppliedInCode) OR a scroll-variant fromVar / sectionVar / sectionId (a quoted JSON
  // value isVariableAppliedInCode can't see). Link attrs (`href={var}` …) are already covered by the `={var}`
  // form, so they need no separate clause.
  const usedVarNames = useMemo(() => {
    const used = new Set<string>();
    for (const v of templateVars) {
      const esc = v.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (
        isVariableAppliedInCode(v.name, templateCode)
        || new RegExp(`"(?:fromVar|sectionVar|sectionId)"\\s*:\\s*"${esc}"`).test(templateCode)
      ) used.add(v.name);
    }
    return used;
  }, [templateVars, templateCode]);

  // Render the right-side control for one template variable, seeded from the
  // page's @templateProps (or the template's param default), writing back via
  // setVar. Typed by @propMeta varType — `section` lists the page's own anchors
  // so each page targets a section ON ITSELF.
  const renderVarControl = (prop: ComponentProp) => {
    const cur = pageTemplateProps[prop.name] ?? (prop.defaultValue ?? '');
    const onChange = (v: string) => setVar(prop.name, v);
    // Variant variable → a SELECT of the bound component's variants (parity
    // with the VariableModal's variant select at create time). Takes priority
    // over `varType` so a hoisted-variant var never falls back to a text input.
    const variantOpts = variantVarOptions.get(prop.name);
    if (variantOpts && variantOpts.length > 0) {
      return <ToolSelect value={cur || variantOpts[0]?.value || ''} onChange={onChange} options={variantOpts} />;
    }
    // Style-prop control DERIVATION (matches the design-component instance tool): a var bound to a
    // SELECT-control style property (justify/align/wrap/overflow/…) renders that exact select even when
    // its @propMeta carries no `option` type — resolved from the property it drives via `varBoundNodes`.
    // Centralizes "the Template tool shows the same control as the panel". Skips when @propMeta already
    // says `option` (that path reads explicit options below).
    // The cssProp the variable ultimately drives (direct binding / hoisted instance prop / shared resolver,
    // incl. per-viewport + overlay custom-prop remap) — shared with the row-level multi-row layout check.
    const drivenProp = getDrivenProp(prop);
    // 1) DEDICATED control atom (flexDirection → the row/column ARROWS, overflow → OverflowControl, …):
    //    render the exact same atom every other surface uses (mirrors VariableModal's atom path).
    const Atom = (prop.varType !== 'option' && drivenProp) ? resolveVariableEditor(drivenProp) : null;
    if (Atom) {
      // `externalOnChangeLive` → previewVar: LIVE imperative DOM patch every frame during a chevron/slider
      // drag (padding, opacity, radius, …), exactly like the color path — `onChange` (setVar) still commits
      // the code ONCE on release. Without this the atom only wrote code on mouse-up = canvas updated late.
      const live = (v: string) => previewVar(prop.name, v);
      // TRANSITION commits CONTINUOUSLY from its panel (no pointer-up); on this large template file the
      // per-frame write+reparse stalls. Debounce the commit (and skip the live patch — nothing visual to
      // preview for a transition). Every other atom keeps the live-drag + commit-once path.
      const isTx = drivenProp === 'transition';
      const commit = isTx ? (v: string) => setVarDebounced(prop.name, v) : onChange;
      const liveCb = isTx ? undefined : live;
      // Multi-row EntryList atoms (Shadow/Filter/Mask) render WITH their own label (LabelOverrideProvider
      // swaps the atom's hardcoded "Shadow" for the variable name; NO hideLabel) inside a flex-col — so the
      // label + first entry sit on one COMPACT row with Add below, EXACTLY like the component-instance tool
      // (not a spread-out full-width block). The caller drops the ToolRow for these.
      if (drivenProp && MULTI_ROW_DRIVEN_PROPS.has(drivenProp)) {
        return (
          <LabelOverrideProvider label={prop.label || prop.name}>
            <div className="flex flex-col gap-2 w-full">
              <UnifiedControlProvider property={drivenProp} mode="variableDefault" externalValue={cur} externalOnChange={onChange} externalOnChangeLive={live}>
                <Atom mode="variableDefault" externalValue={cur} externalOnChange={onChange} externalOnChangeLive={live} />
              </UnifiedControlProvider>
            </div>
          </LabelOverrideProvider>
        );
      }
      return (
        <UnifiedControlProvider property={drivenProp!} mode="variableDefault" externalValue={cur} externalOnChange={commit} externalOnChangeLive={liveCb} hideLabel>
          <Atom mode="variableDefault" externalValue={cur} externalOnChange={commit} externalOnChangeLive={liveCb} hideLabel />
        </UnifiedControlProvider>
      );
    }
    // 2) Generic SELECT-control property (justify/align/…) with no dedicated atom → its locked select.
    if (prop.varType !== 'option') {
      const ctrl = drivenProp ? resolveControl(drivenProp) : null;
      if (ctrl?.type === 'select') {
        // `ctrl.options` is already `{ value, label }[]` (CSSOption) — pass it straight through.
        return <ToolSelect value={cur} onChange={onChange} options={ctrl.options} />;
      }
    }
    switch (prop.varType) {
      case 'color':
        // onChangeLive → direct DOM patch per drag frame (60fps); onChange
        // (pointer-up) commits the route map to code.
        return <ColorInput value={cur} onChange={onChange} onChangeLive={(v) => previewVar(prop.name, v)} showAlpha />;
      case 'toggle':
      case 'boolean':
        return (
          <ToolSegmentedControl
            value={cur === 'true' ? 'true' : 'false'}
            onChange={onChange}
            options={[{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }]}
            size="sm"
          />
        );
      case 'option':
        return <ToolSelect value={cur} onChange={onChange} options={getPropOptions(templateCode, prop.name).map(o => ({ value: o, label: o }))} />;
      case 'section':
        return <ToolSelect value={cur} onChange={onChange} options={[{ value: '', label: '—' }, ...pageAnchors.map(a => ({ value: a, label: a }))]} />;
      case 'number':
        return <ToolInput value={cur} onChange={onChange} placeholder={prop.defaultValue ?? ''} />;
      case 'link':
        // The page/CMS picker (same control the LinkTool + variable modal use) — not a raw text input.
        return <LinkUrlField value={cur} onChange={onChange} />;
      case 'componentCursor':
        // A hoisted COMPONENT cursor → the SAME full Component Cursor popup as the instance editor (Component
        // picker + Mode + Size + Position + Transition + Enter/Exit). Writes route to the TEMPLATE: the
        // component to the variable's param default, the behaviour to the master's withCursor.
        return (
          <TemplateCursorRow
            varName={prop.name}
            label={prop.label || prop.name}
            templateCode={templateCode}
            clientPath={currentTpl?.clientPath ?? ''}
            currentDefault={prop.defaultValue ?? ''}
            onChanged={() => { /* modifyProjectFile bumps the project version → the tool re-reads templateCode */ }}
          />
        );
      default:
        return <ToolInput value={cur} onChange={onChange} text placeholder={prop.defaultValue ?? ''} />;
    }
  };

  return (
    <>
      <ToolSection
        title="Template"
        collapsible
        // Variants always show the body (an editable Layout dropdown), even
        // when set to None — that's how you switch back to a template.
        hasContent={hasTemplate || isVariant}
        action={isVariant ? undefined : toggleAction}
      >
        {/* `ToolSection` returns null when it has zero valid children, so
            the empty-template state still needs a sentinel child to keep
            the header rendering. `hasContent={false}` hides the body
            visually; the sentinel never paints. Same approach LayoutTool
            uses for its no-layout empty state. */}
        {(hasTemplate || isVariant) ? (
          <>
            <ToolRow label="Layout">
              {isVariant ? (
                // A variant picks its OWN template (or None) — independent of
                // the Control. Writes the choice to the manifest, no file move.
                <ToolSelect
                  value={currentTemplate ?? VARIANT_NONE}
                  onChange={handleVariantPick}
                  options={[...options, { value: VARIANT_NONE, label: 'None' }]}
                />
              ) : (
                <ToolSelect value={currentTemplate ?? ''} onChange={handlePick} options={options} />
              )}
            </ToolRow>
            {/* Template variables + Edit only when a template is actually applied
                (a variant set to None has neither). One control per variable
                declared in the template's LayoutClient (component-tool parity). */}
            {hasTemplate && (
              <>
                {templateVars.some((p) => usedVarNames.has(p.name)) && <ToolDivider />}
                {templateVars.filter((prop) => usedVarNames.has(prop.name)).map((prop) => {
                  const dp = getDrivenProp(prop);
                  // Multi-row EntryList atoms (Shadow/Filter/Mask) render their OWN label + stacked entries
                  // (renderVarControl returns a LabelOverrideProvider'd atom) — drop the horizontal ToolRow so
                  // the compact label|entry + Add layout matches the component-instance tool exactly.
                  if (dp && MULTI_ROW_DRIVEN_PROPS.has(dp)) {
                    return <div key={prop.name} className="w-full">{renderVarControl(prop)}</div>;
                  }
                  return (
                    <ToolRow key={prop.name} label={prop.label || prop.name} truncateLabel>
                      {renderVarControl(prop)}
                    </ToolRow>
                  );
                })}
                <ToolDivider />
                <ToolButton onClick={handleEdit} disabled={editDisabled}>
                  Edit
                </ToolButton>
              </>
            )}
          </>
        ) : (
          <span aria-hidden="true" />
        )}
      </ToolSection>

      <NameInputModal
        isOpen={createModalOpen}
        onClose={() => setCreateModalOpen(false)}
        onSubmit={handleCreateAndApply}
        title="New Template"
        placeholder="e.g. marketing, dashboard, blog..."
        defaultValue=""
        submitLabel="Create"
        // Templates wear the component-system accent everywhere — Library
        // panel, File Explorer, and here.
        accent="secondary"
        validate={validateTemplateName}
      />
    </>
  );
}
