// ScrollVariantEditor.tsx — popup for the Scroll Variant effect (component instances).
// Mirrors ScrollTransformEditor's trigger UI (On Scroll / Layer in View / Section in
// View + multi-section), but each "To" is a VARIANT picker — picking the variant the
// component morphs to. Writes a single `updateScrollVariant` mutation per change.
import { useCallback, useMemo, Fragment } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { ControlLabel, ToolSelect, ToolSegmentedControl, ToolDivider } from '../../../controls';
import { HoistMenuItemProvider } from '../../../controls/hoist-context';
import type { MenuItem } from '../../../controls/control-menu-items';
import { parseComponentInfoFromSource } from '@/code/components/component-registry';
import { queueMutation, flushNow } from '@/code/mutation/mutation-queue';
import { projectFS, projectVersionAtom } from '@/code/project/project-fs';
import { variableModalRequestAtom } from '@/code/stores/store';
import { modifyProjectFile } from '@/code/project/modify-file';
import { ensureComponentAcceptsRef, resolveScrollVariantConfig, setScrollVariantFieldScoped, resolveSectionTarget, setSectionTargetScoped } from '@/code/generation/scroll-variant-gen';
import { createTypedVariableInCode } from '@/code/features/variable-ops';
import { setPropTypeInCode, setPropLabelInCode, getPropLabel } from '@/code/components/prop-meta';
import { parseVariantConfig } from '@/code/variants/variant-config';
import { activeFilePathAtom, componentBreadcrumbAtom, isTemplateFilePath, isComponentFilePath } from '@/code/project/active-file-store';
import { getAnchorsForPage } from '../../LinkTool/LinkUrlControl';
import { getActiveAnimationScope } from '../animation-scope-source';
import { ViewportIcon } from './ScrollEditor';
import type { ScrollVariantSpec, ScrollVariantTrigger } from '@/code/generation/scroll-variant-gen';
import type { SerScope } from '@/code/generation/generator-motion';

// Hoisted (NOT defined inside the component) — a per-render component identity would
// remount the whole subtree each change, killing ToolSegmentedControl's slide.
const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="flex items-center justify-between w-full">
    <ControlLabel label={label} property="" plain />
    <div className="w-full">{children}</div>
  </div>
);

/** First free `scrollSection` / `scrollSection2` … name not already a prop in the code. */
function uniqueSectionVarName(code: string): string {
  const base = 'scrollSection';
  if (!new RegExp(`\\b${base}\\b`).test(code)) return base;
  let n = 2;
  while (new RegExp(`\\b${base}${n}\\b`).test(code)) n++;
  return `${base}${n}`;
}

/** The component's variants as `{ value: internalName, label: userLabel }` for a picker. */
function useVariantOptions(componentFile: string | null | undefined): { value: string; label: string }[] {
  if (!componentFile) return [];
  try {
    const code = projectFS.readFile(componentFile);
    if (!code) return [];
    return parseVariantConfig(code).map((v) => ({ value: v.name, label: v.label || v.name }));
  } catch { return []; }
}

export function ScrollVariantEditor({ nodeId, componentFile, spec }: {
  nodeId: string;
  componentFile: string | null | undefined;
  spec: ScrollVariantSpec;
}) {
  const variantOpts = useVariantOptions(componentFile);
  const from = spec.from || variantOpts[0]?.value || 'default';

  // Section options = page ANCHORS (elements with an `id`) — same source as Scroll
  // Transform, so they stay consistent across the editor. Not arbitrary nodes.
  // Inside a TEMPLATE (or a component opened from a page), the active file is the
  // LayoutClient/master which has NO sections — the sections live on the
  // ORIGINATING PAGE. `componentBreadcrumb[0]` is that page (TemplatePicker Edit
  // + component double-click seed it), so resolve anchors from there. Otherwise
  // ("No anchors on page" forever when scroll-variant-ing inside a template).
  const activeFilePath = useAtomValue(activeFilePathAtom);
  const breadcrumb = useAtomValue(componentBreadcrumbAtom);
  const anchorPage = useMemo(() => (
    (isTemplateFilePath(activeFilePath) || isComponentFilePath(activeFilePath)) && breadcrumb[0]
      ? breadcrumb[0]
      : activeFilePath
  ), [activeFilePath, breadcrumb]);
  const anchors = useMemo(() => (anchorPage ? getAnchorsForPage(anchorPage) : []), [anchorPage]);
  const sectionOpts = [
    { value: '', label: anchors.length === 0 ? 'No anchors on page' : 'Select…' },
    ...anchors.map((id) => ({ value: id, label: `#${id}` })),
  ];

  const write = useCallback((patch: Partial<ScrollVariantSpec>) => {
    const next = { ...spec, from, ...patch } as ScrollVariantSpec;
    queueMutation({ type: 'updateScrollVariant', nodeId, spec: next });
    // layerInView `useInView`s the instance's real DOM box via a ref. The component
    // must accept + attach that ref (React 19 ref-as-prop). Idempotent — flushes the
    // page mutation above first, then patches the component file once.
    if (next.trigger === 'layerInView' && componentFile) {
      modifyProjectFile(componentFile, ensureComponentAcceptsRef);
    }
  }, [nodeId, spec, from, componentFile]);

  // From / To / Direction are per-viewport responsive: editing on a replica writes THAT
  // tile's override (responsive[scope]) keeping the base — e.g. Desktop scrolls Down→abc1,
  // Tablet scrolls Up→abc2. On primary it edits the base. (Replay/Trigger stay base-level.)
  // sectionInView has per-section targets, so it edits the base directly.
  const activeScope = getActiveAnimationScope() as SerScope | null;
  const cfg = resolveScrollVariantConfig(spec, activeScope);   // base ⊕ this tile's override
  const writeScoped = useCallback((patch: { from?: string; to?: string; direction?: 'down' | 'up' }) => {
    const next = setScrollVariantFieldScoped({ ...spec, from }, patch, activeScope);
    queueMutation({ type: 'updateScrollVariant', nodeId, spec: next });
  }, [nodeId, spec, from, activeScope]);

  // ── Section → TEMPLATE VARIABLE (per-page section targeting) ────────────────
  // In a template, "Create Variable" on the Section turns the literal section id
  // into a LayoutClient param (`varType: 'section'`, default = the picked
  // originating-page anchor). The scroll runtime then emits
  // `getElementById(scrollSection)`, the LayoutClient reassigns it per-route via
  // usePathname (template-route-gen, reassignment at body top so it precedes the
  // scroll useEffect), and the Template tool surfaces it as a per-page anchor
  // picker. Only shown inside a template (per-page targeting is the point).
  const isTemplate = isTemplateFilePath(activeFilePath);
  const setVariableModalRequest = useSetAtom(variableModalRequestAtom);
  // Resolve a bound section var's DISPLAY LABEL (@propMeta) so the pill shows the
  // friendly name the user set in the Variable modal (e.g. "333"), not the raw
  // camelCase identifier (scrollSection3). Re-read on every flush (projectVersion)
  // so a rename reflects immediately. Falls back to the identifier when unlabelled.
  const projectVersion = useAtomValue(projectVersionAtom);
  const sectionVarLabel = useCallback((name: string): string => {
    if (!activeFilePath) return name;
    void projectVersion; // re-evaluate after each mutation flush
    return getPropLabel(projectFS.readFile(activeFilePath) ?? '', name) || name;
  }, [activeFilePath, projectVersion]);
  const createSectionVar = useCallback((i: number) => {
    const sections = spec.sections || [];
    const sec = sections[i];
    if (!sec || !activeFilePath) return;
    const name = uniqueSectionVarName(projectFS.readFile(activeFilePath) ?? '');
    const def = sec.sectionId || '';
    modifyProjectFile(activeFilePath, (code) => {
      let c = createTypedVariableInCode(code, name, 'string', def);
      c = setPropTypeInCode(c, name, 'section');
      c = setPropLabelInCode(c, name, 'Scroll Section');
      return c;
    });
    // Bind the section to the new var — the generator emits getElementById(name).
    write({ sections: sections.map((s, j) => (j === i ? { ...s, sectionVar: name } : s)) });
    // Open the Variable modal on the new var with the Name editable — same as the
    // standard "Create Variable" flow (auto-create then rename). Flush first so the
    // var exists in the file before the modal reads it.
    flushNow();
    setVariableModalRequest({ property: '', propertyLabel: 'Section', currentValue: def, variableRef: name, nameEditable: true });
  }, [spec, activeFilePath, write, setVariableModalRequest]);
  /** Open the manage modal on an already-bound section variable (pill click). */
  const openSectionVarModal = useCallback((sec: { sectionId: string; sectionVar?: string }) => {
    if (!sec.sectionVar) return;
    setVariableModalRequest({ property: '', propertyLabel: 'Section', currentValue: sec.sectionId || '', variableRef: sec.sectionVar, nameEditable: false });
  }, [setVariableModalRequest]);
  const unbindSectionVar = useCallback((i: number) => {
    const sections = spec.sections || [];
    write({ sections: sections.map((s, j) => (j === i ? { ...s, sectionVar: undefined } : s)) });
  }, [spec, write]);
  /** Bind this section to an EXISTING section variable (the "Set Variable" submenu). */
  const setSectionVar = useCallback((i: number, name: string) => {
    const sections = spec.sections || [];
    write({ sections: sections.map((s, j) => (j === i ? { ...s, sectionVar: name } : s)) });
  }, [spec, write]);
  // The template's already-defined SECTION variables (signature props typed
  // `section` in @propMeta) — the candidates for "Set Variable". Re-read on flush.
  const sectionVars = useMemo(() => {
    void projectVersion;
    if (!activeFilePath) return [] as { name: string; label: string }[];
    const code = projectFS.readFile(activeFilePath) ?? '';
    const info = code ? parseComponentInfoFromSource(activeFilePath, code, String(code.length)) : null;
    return (info?.props ?? [])
      .filter(p => p.varType === 'section')
      .map(p => ({ name: p.name, label: p.label || p.name }));
  }, [activeFilePath, projectVersion]);
  // Chevron menu items for an UNBOUND section row inside a template: "Create
  // Variable" always, plus a "Set Variable" submenu of existing section vars.
  const sectionMenuItems = useCallback((i: number): MenuItem[] => {
    const items: MenuItem[] = [
      { label: 'Create Variable', show: true, hoverColor: 'accent-secondary', onClick: () => createSectionVar(i) },
    ];
    if (sectionVars.length > 0) {
      items.push({
        label: 'Set Variable',
        show: true,
        hoverColor: 'accent-secondary',
        onClick: () => { /* parent is a no-op; the submenu opens on hover */ },
        submenuItems: sectionVars.map(v => ({
          label: v.label,
          show: true,
          hoverColor: 'accent-secondary',
          onClick: () => setSectionVar(i, v.name),
        })),
      });
    }
    return items;
  }, [sectionVars, createSectionVar, setSectionVar]);

  const variantSelect = (value: string | undefined, onChange: (v: string) => void) => (
    <ToolSelect value={value || ''} onChange={onChange}
      options={[{ value: '', label: 'Set Variant…' }, ...variantOpts]} />
  );

  return (
    // pl-1.5 gives the ControlLabel's 18px chevron gutter room inside the popup's
    // px-3 padding (12+6=18) so the "Section" chevron isn't clipped by the edge.
    <div className="flex flex-col gap-2 pl-1.5">
      <Row label="Trigger">
        <ToolSelect value={spec.trigger}
          onChange={(v) => {
            const t = v as ScrollVariantTrigger;
            // Seed sensible defaults when switching trigger so the spec is always valid.
            if (t === 'sectionInView') write({ trigger: t, viewport: spec.viewport || 'middle', sections: spec.sections?.length ? spec.sections : [{ sectionId: '', to: '' }] });
            else write({ trigger: t, to: spec.to || variantOpts[1]?.value || from, ...(t === 'onScroll' ? { direction: spec.direction || 'down' } : { start: spec.start || 'center' }) });
          }}
          options={[
            { value: 'onScroll', label: 'On Scroll' },
            { value: 'layerInView', label: 'Layer in View' },
            { value: 'sectionInView', label: 'Section in View' },
          ]} />
      </Row>

      {spec.trigger === 'onScroll' && (
        <Row label="Direction">
          <ToolSegmentedControl value={cfg.direction}
            onChange={(v) => writeScoped({ direction: v as 'down' | 'up' })}
            options={[{ value: 'down', label: 'Down' }, { value: 'up', label: 'Up' }]} size="sm" />
        </Row>
      )}
      {spec.trigger === 'layerInView' && (
        <Row label="Start">
          <ToolSegmentedControl value={spec.start || 'center'}
            onChange={(v) => write({ start: v as 'top' | 'center' | 'bottom' })}
            options={[
              { value: 'top', icon: <ViewportIcon position="top" /> },
              { value: 'center', icon: <ViewportIcon position="middle" /> },
              { value: 'bottom', icon: <ViewportIcon position="bottom" /> },
            ]} size="sm" />
        </Row>
      )}
      {spec.trigger === 'sectionInView' && (
        <Row label="Viewport">
          <ToolSegmentedControl value={spec.viewport || 'middle'}
            onChange={(v) => write({ viewport: v as 'top' | 'middle' | 'bottom' })}
            options={[
              { value: 'top', icon: <ViewportIcon position="top" /> },
              { value: 'middle', icon: <ViewportIcon position="middle" /> },
              { value: 'bottom', icon: <ViewportIcon position="bottom" /> },
            ]} size="sm" />
        </Row>
      )}

      <Row label="Replay">
        <ToolSegmentedControl value={spec.replay === false ? 'no' : 'yes'}
          onChange={(v) => write({ replay: v === 'yes' })}
          options={[{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }]} size="sm" />
      </Row>

      {/* On Scroll (design-tool parity): only a "To". The FROM is the element's resting variant
          (the per-viewport InitialVariant choice) — NOT a field here, so picking a scroll
          target never changes the displayed variant. Layer in View has an explicit From + To
          (enter→To, leave→From). sectionInView uses per-section targets below. */}
      {spec.trigger === 'onScroll' && (
        <Row label="To">{variantSelect(cfg.to, (v) => writeScoped({ to: v }))}</Row>
      )}
      {spec.trigger === 'layerInView' && (
        <>
          <Row label="From">{variantSelect(cfg.from, (v) => writeScoped({ from: v }))}</Row>
          <Row label="To">{variantSelect(cfg.to, (v) => writeScoped({ to: v }))}</Row>
        </>
      )}

      {/* Multi-section: each section → a variant. NO From, NO Transition (the reference's
          Section-in-View variant is just Section → To). Each group is separated by a
          ToolDivider, matching the Scroll Transform popup exactly. */}
      {spec.trigger === 'sectionInView' && (
        <>
          {(spec.sections || []).map((sec, i) => (
            <Fragment key={i}>
              {i > 0 && <ToolDivider />}
              {/* Section label = the STANDARD ControlLabel (chevron + menu) — same
                  reusable component as every other control. Inside a template (and
                  not yet bound) a HoistMenuItemProvider injects a "Create Variable"
                  item into its chevron menu (and suppresses the CSS-property
                  standard items), routing to the section-var create flow — exactly
                  how ComponentPropsTool surfaces "Hoist Variable". */}
              <div className="flex items-center justify-between w-full">
                {isTemplate && !sec.sectionVar ? (
                  <HoistMenuItemProvider item={sectionMenuItems(i)}>
                    <ControlLabel label="Section" property="" hideCopyPasteStyle />
                  </HoistMenuItemProvider>
                ) : (
                  <ControlLabel label="Section" property="" plain />
                )}
                {/* min-w-0 lets this flex child shrink below its content width so a
                    long variable name truncates instead of pushing the pill wider
                    than the dropdowns in the other rows. */}
                <div className="w-full min-w-0">
                  {sec.sectionVar ? (
                    // Bound to a template variable — purple pill: click opens the manage
                    // modal (like every variable pill); × unbinds (back to a literal).
                    <button type="button" onClick={() => openSectionVarModal(sec)}
                      className="w-full max-w-full min-w-0 h-8 flex items-center gap-2 pl-2 pr-1 rounded-[var(--radius-lg)] text-xs font-medium text-[var(--accent-secondary-fg)] cursor-pointer hover:opacity-90 transition-opacity"
                      style={{ backgroundColor: 'var(--accent-secondary)' }} title={`Variable: ${sectionVarLabel(sec.sectionVar)} — click to manage`}>
                      <span className="truncate flex-1 min-w-0 text-left">{sectionVarLabel(sec.sectionVar)}</span>
                      <span role="button" tabIndex={0} onClick={(e) => { e.stopPropagation(); unbindSectionVar(i); }}
                        className="text-[var(--accent-secondary-fg)]/70 hover:text-[var(--accent-secondary-fg)] text-sm leading-none shrink-0 cursor-pointer px-1" title="Remove variable">×</span>
                    </button>
                  ) : (
                    <ToolSelect value={sec.sectionId || ''} options={sectionOpts}
                      onChange={(id) => write({ sections: (spec.sections || []).map((s, j) => j === i ? { ...s, sectionId: id } : s) })} />
                  )}
                </div>
              </div>
              <Row label="To">
                {/* Per-viewport target (single-section): editing on a replica writes THIS tile's
                    override (responsive[scope].to) keeping the base — desktop → default-scrolled,
                    mobile → mobile-scrolled — exactly like Scroll Transform. Multi-section keeps the
                    base target (the flat responsive override can't disambiguate sections). */}
                {(() => {
                  const toScope = (spec.sections || []).length === 1 ? activeScope : null;
                  return variantSelect(resolveSectionTarget(spec, i, toScope), (v) =>
                    queueMutation({ type: 'updateScrollVariant', nodeId, spec: setSectionTargetScoped({ ...spec, from }, i, v, toScope) }));
                })()}
              </Row>
            </Fragment>
          ))}
          <div className="sticky bottom-0 -mx-3 px-3 pt-2 pb-1 bg-[var(--bg-surface)] z-10">
            <button onClick={() => write({ sections: [...(spec.sections || []), { sectionId: '', to: '' }] })}
              className="w-full h-[var(--control-height)] flex items-center justify-center text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] bg-[var(--grid-line)] border border-[var(--control-border)] hover:border-[var(--control-border-hover)] rounded-[var(--radius-lg)] cursor-pointer transition-colors">
              Add Section
            </button>
          </div>
        </>
      )}
    </div>
  );
}
