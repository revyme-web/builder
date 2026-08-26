// VariableModal.tsx — Two-panel modal for managing component variables (props).
// Left panel: list existing variables + "Create new" button.
// Right panel: create form (name + default value control) or view existing variable details.
// Uses control-registry to render the correct control type for the CSS property.
// Design pixel-matched to the old builder's VariableModal.

import { useState, useMemo, useEffect, useLayoutEffect, useCallback, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useAtomValue, useSetAtom } from 'jotai';
import Modal from '@/design-system/Modal';
import { activeFilePathAtom, isComponentLikeFilePath } from '@/code/project/active-file-store';
import { buildComponentRegistry, parseComponentInfoFromSource, STRUCTURAL_PROPS, type ComponentProp } from '@/code/components/component-registry';
import { inferPropertyFromValue, resolveVariableCssProp, type ChildResolution } from '@/code/components/prop-css-mapping';
import { getPropOptions, getPropOptionsLocked, getPropNumberMeta, getPropDescription, getPropLabel, parsePropMeta, type PropNumberMeta } from '@/code/components/prop-meta';
import NumberVariableEditor from '../controls/NumberVariableEditor';
import { VariableTypeIcon, resolveVariableIconKey } from '../controls/VariableTypeIcon';
import { VariableTypePicker } from '../controls/VariableTypePicker';
import { getVariableType, type VariableTypeDef } from '../controls/variable-types';
import { projectFS, projectVersionAtom } from '@/code/project/project-fs';
import { selectedIdsAtom, getNodesSnapshot } from '@/code/stores/store';
import { getContentRoot } from '@/canvas/node-ops';
import { zoomToFitNodes } from '@/canvas/transform';

const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Extract a node's OPENING tag (`<… data-id="id" …>`) from raw code — brace-aware so style/prop expressions
 *  (which contain `>` inside `{…}`) don't truncate it. The opening tag holds every style/prop/attr binding,
 *  INCLUDING ones the parser flattens or loses (a per-viewport bool-nav var buried in `(__mq ? v : base) ? …`,
 *  a link href ternary, a scroll-variant JSON) — so a raw scan catches usages `node.attrs` can't. */
function openingTag(code: string, id: string): string | null {
  const idx = code.indexOf(`data-id="${id}"`);
  if (idx === -1) return null;
  const start = code.lastIndexOf('<', idx);
  let depth = 0, i = idx;
  for (; i < code.length; i++) {
    const c = code[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '>' && depth === 0) break;
  }
  return start === -1 ? null : code.slice(start, i + 1);
}
import { queueMutation, flushNow, setForceRender } from '@/code/mutation/mutation-queue';
import { cascadeDeleteVariableUp } from '@/code/features/cascade-delete-variable';
import { extractComponentPropDefaults, parseJSXToNodes } from '@/code/parsing/parser';
import { getScrollVariant } from '@/code/generation/scroll-variant-gen';
import { extractImports, resolveImportPath } from '@/code/components/import-resolver';
import { parseVariantConfig, selectableVariants } from '@/code/variants/variant-config';
import { parseJSX } from '@/code/parsing/ast-utils';
import { resolveControl } from '../controls/control-registry';
import { resolveVariableEditor } from '../controls/variable-editor-registry';
import { UnifiedControlProvider } from '../controls/unified';
import { ToolInput, ToolSlider, ToolSelect, ToolSegmentedControl, ControlActionRow, RemoveButton } from '../controls';
import { pageVariablesAtom } from '@/code/stores/page-variables-store';
import { trace } from '@/shared/debug-trace';

// ─── Types ──────────────────────────────────────────────────────────────────

interface VariableModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** CSS property name (e.g., 'justifyContent'). Omitted in `manage` mode. */
  property?: string;
  /** Display label (e.g., 'Justify'). Omitted in `manage` mode. */
  propertyLabel?: string;
  /** Current style value for auto-filling default */
  currentValue?: string;
  /** Called when user creates a new variable. defaultValue is the value set in the modal form.
   *  `numberMeta` carries the min/max/step/unit/control config when creating a Number variable (so the
   *  caller persists it onto the new variable — making it a full Number variable, not a bare value). */
  onCreateVariable?: (propName: string, defaultValue: string, numberMeta?: NumberMetaPatch) => void;
  /** When set, the create form is for a NUMBER variable: render the full Min/Max/Step/Unit/Control editor
   *  (seeded from this), so a variable created from a code-component number control is the SAME unified
   *  Number type — with its full config — as a Number variable created from opacity/gap on a normal node. */
  createNumberMeta?: PropNumberMeta;
  /** Called when user removes a variable */
  onRemoveVariable?: (propName: string, defaultValue: string) => void;
  /** Currently bound variable name (if any) */
  currentVariableRef?: string | null;
  /**
   * Management mode — opened from the component breadcrumb rather than a
   * property control. Browses every variable on the active component master;
   * there is no property to create-from or bind-to, so the create / use /
   * remove affordances are hidden and the modal is a read-only browser.
   */
  manage?: boolean;
  /**
   * Pre-fill the create-form's name input. Used by the "Hoist Variable"
   * entry point on nested-instance prop rows: the source prop's name is
   * the natural default so the user can confirm in two clicks. Empty
   * string / undefined falls back to the regular blank-form behaviour.
   */
  initialName?: string;
  /**
   * Override the "Default Value" editor. When provided, this renders instead
   * of the property-derived control (control-registry / variable-editor).
   * Used when creating a variable FROM a Code component `@control` (color / slider /
   * …) where there's no CSS property to resolve a control from — the caller
   * passes the code component's real control so the default value is editable with the
   * right UI instead of a bare text input.
   */
  renderDefaultValue?: (value: string, onChange: (v: string) => void) => ReactNode;
  /** Hide the "Default" row entirely (Name + Description only). Used for component cursors, which have
   *  no default value (their behaviour is configured on the element, standard). */
  hideDefault?: boolean;
  /** Focus + select the Name field on open so the user can immediately rename — used right after
   *  "Create Variable" (the variable exists with an auto-name; the user types their real name). */
  nameEditable?: boolean;
  /** LIVE imperative preview of a variable's value during a drag in the Default control (color / border
   *  width / slider), patching the bound canvas nodes per frame — the commit still writes code on release.
   *  Without it the Default editor commits + re-parses every frame (slow fps). Supplied by VariableModalHost
   *  via useVariablePreview. `name` is the variable being previewed (no-op for a brand-new, unbound var). */
  onPreviewLive?: (name: string, value: string) => void;
}

type Mode = 'list' | 'create' | 'view';

const CAMEL_CASE_RE = /^[a-z][a-zA-Z0-9]*$/;

// ─── Field row ────────────────────────────────────────────────────────────────
// One settings row: label on the LEFT (fixed column), control on the RIGHT (fills). `align` controls
// vertical alignment — 'center' for single-line inputs, 'start' for the textarea / multi-row controls.
function FieldRow({ label, children, align = 'center' }: { label: string; children: ReactNode; align?: 'center' | 'start' }) {
  return (
    <div className={`flex gap-4 ${align === 'start' ? 'items-start' : 'items-center'}`}>
      <label className={`w-24 flex-shrink-0 text-xs text-[var(--text-secondary)] ${align === 'start' ? 'pt-2' : ''}`}>
        {label}
      </label>
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  );
}

// ─── Auto-growing textarea ──────────────────────────────────────────────────────
// Fits its content exactly: collapses to one line (≈ the single-line inputs' h-8) when empty and grows
// as you type, with no reserved empty rows or trailing whitespace. `field-sizing: content` proved flaky
// here (computed a too-tall height with resize/flex), so we size manually via scrollHeight. overflow
// hidden + resize-none because the height is always driven to fit.
function AutoGrowTextarea({ value, onChange, onBlur, placeholder, minRows = 1 }: {
  value: string; onChange: (v: string) => void; onBlur?: () => void; placeholder?: string; minRows?: number;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const fit = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  };
  useLayoutEffect(fit, [value]);
  return (
    <textarea
      ref={ref}
      rows={minRows}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onInput={fit}
      onBlur={onBlur}
      placeholder={placeholder}
      className="w-full px-3 py-1.5 text-xs leading-snug bg-[var(--grid-line)] cut-corners cut-border [--cut-border-color:var(--border-light)] hover:[--cut-border-color:var(--control-border)] focus:[--cut-border-color:var(--border-focus)] text-[var(--text-primary)] border border-[var(--border-light)] hover:border-[var(--control-border)] focus:border-[var(--border-focus)] focus:outline-none transition-colors resize-none overflow-hidden block"
    />
  );
}

// ─── Option (enum) default editor ──────────────────────────────────────────────
// Manages the choice list for an Option variable (persisted to `@propMeta.options` via mutation) and
// lets the user pick which choice is the default (the variable's defaultValue, via `onChange`). The
// radio dot marks the default; the text input edits a choice; × removes it.
function OptionDefaultEditor({ varName, value, onChange, options }: {
  varName: string; value: string; onChange: (v: string) => void; options: string[];
}) {
  const [opts, setOpts] = useState<string[]>(options.length ? options : ['']);
  // Re-seed when switching to a different variable (not on every options identity change, to keep typing smooth).
  useEffect(() => { setOpts(options.length ? options : ['']);   }, [varName]);

  const commit = (next: string[]) => {
    setOpts(next);
    queueMutation({ type: 'setComponentPropOptions', propName: varName, options: next.map(o => o.trim()).filter(Boolean) });
    trace.action('variable-modal:option-edit', { varName, count: next.filter(Boolean).length });
  };
  const updateAt = (i: number, v: string) => { const n = [...opts]; const prev = n[i]; n[i] = v; commit(n); if (value === prev) onChange(v); };
  const removeAt = (i: number) => { const removed = opts[i]; const n = opts.filter((_, j) => j !== i); commit(n.length ? n : ['']); if (value === removed) onChange((n[0] ?? '').trim()); };
  const add = () => commit([...opts, '']);

  return (
    <div className="flex flex-col gap-1.5">
      {opts.map((o, i) => (
        <div key={i} className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => o.trim() && onChange(o.trim())}
            title="Set as default"
            className={`w-4 h-4 rounded-full border flex items-center justify-center shrink-0 transition-colors ${
              value === o && o.trim() ? 'border-[var(--accent-secondary)]' : 'border-[var(--control-border)] hover:border-[var(--control-border-hover)]'
            }`}
          >
            {value === o && o.trim() && <span className="w-2 h-2 rounded-full" style={{ backgroundColor: 'var(--accent-secondary)' }} />}
          </button>
          <ToolInput value={o} onChange={(v) => updateAt(i, v)} text />
          <RemoveButton onClick={() => removeAt(i)} />
        </div>
      ))}
      <ControlActionRow onClick={add}>
        <span className="text-xs text-[var(--text-secondary)]">Add option…</span>
      </ControlActionRow>
    </div>
  );
}

// ─── Number-variable knobs (Min / Max / Step / Unit / Control) ───────────────
// the reference's ControlType.Number config. Persists to @propMeta via setComponentPropNumberMeta. Reads live
// from `componentCode` (re-passed on every projectVersion bump) so the rows reflect the saved values.
const NUMBER_UNIT_OPTIONS = [
  { value: 'None', label: 'None' }, { value: 'px', label: 'px' }, { value: '%', label: '%' },
  { value: 'em', label: 'em' }, { value: 'rem', label: 'rem' }, { value: 'deg', label: 'deg' },
  { value: 'vh', label: 'vh' }, { value: 'vw', label: 'vw' },
];

type NumberMetaPatch = { min?: number | null; max?: number | null; step?: number | null; unit?: string | null; control?: 'slider' | 'stepper' | null };

/** Presentational Min/Max/Step/Unit/Control editor — works off a `meta` object + a `patch` callback, so
 *  it's reusable both code-backed (view mode) and with local state (create-from-number-control). */
function NumberMetaFields({ meta, patch }: { meta: PropNumberMeta; patch: (m: NumberMetaPatch) => void }) {
  const numStr = (n: number | undefined) => (n === undefined ? '' : String(n));
  const ClearBtn = ({ onClick }: { onClick: () => void }) => (
    <button type="button" onClick={onClick}
      className="h-[var(--control-height)] px-3 cut-corners cut-border [--cut-border-color:var(--border-light)] text-xs font-medium bg-[var(--grid-line)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] border border-[var(--border-light)] shrink-0">
      Clear
    </button>
  );
  return (
    <>
      <FieldRow label="Min">
        <div className="flex items-center gap-2 w-full">
          <ToolInput value={numStr(meta.min)} onChange={(v) => patch({ min: v.trim() === '' ? null : parseFloat(v) })} placeholder="—" />
          <ClearBtn onClick={() => patch({ min: null })} />
        </div>
      </FieldRow>
      <FieldRow label="Max">
        <div className="flex items-center gap-2 w-full">
          <ToolInput value={numStr(meta.max)} onChange={(v) => patch({ max: v.trim() === '' ? null : parseFloat(v) })} placeholder="—" />
          <ClearBtn onClick={() => patch({ max: null })} />
        </div>
      </FieldRow>
      <FieldRow label="Step">
        <ToolInput value={numStr(meta.step)} onChange={(v) => patch({ step: v.trim() === '' ? null : parseFloat(v) })} placeholder="1" />
      </FieldRow>
      <FieldRow label="Unit">
        <ToolSelect value={meta.unit ?? 'None'} onChange={(v) => patch({ unit: v === 'None' ? null : v })} options={NUMBER_UNIT_OPTIONS} />
      </FieldRow>
      <FieldRow label="Control">
        <ToolSegmentedControl
          value={meta.control ?? 'slider'}
          onChange={(v) => patch({ control: v as 'slider' | 'stepper' })}
          options={[{ value: 'slider', label: 'Slider' }, { value: 'stepper', label: 'Stepper' }]}
          size="sm"
        />
      </FieldRow>
    </>
  );
}

/** Code-backed wrapper — reads/writes a number variable's meta from/to the component code. */
function NumberMetaConfig({ varName, componentCode }: { varName: string; componentCode: string }) {
  return (
    <NumberMetaFields
      meta={getPropNumberMeta(componentCode, varName)}
      patch={(m) => {
        queueMutation({ type: 'setComponentPropNumberMeta', propName: varName, meta: m });
        trace.action('variable-modal:number-meta', { varName, ...m });
      }}
    />
  );
}

// ─── Component ──────────────────────────────────────────────────────────────

export default function VariableModal({
  isOpen,
  onClose,
  property = '',
  propertyLabel = '',
  currentValue = '',
  onCreateVariable,
  onRemoveVariable,
  currentVariableRef = null,
  manage = false,
  initialName,
  renderDefaultValue,
  hideDefault,
  nameEditable,
  onPreviewLive,
  createNumberMeta,
}: VariableModalProps) {
  const [mode, setMode] = useState<Mode>('list');
  const [selectedVar, setSelectedVar] = useState<string | null>(null);
  // Auto-scroll the left list to the selected variable when the modal opens / selection changes — a deep
  // variable in a long list must be visible without the user manually scrolling the list pane.
  const selectedRowRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (isOpen && selectedVar) selectedRowRef.current?.scrollIntoView({ block: 'nearest' });
  }, [isOpen, selectedVar]);
  const [newName, setNewName] = useState('');
  const [defaultValue, setDefaultValue] = useState(currentValue);
  const [description, setDescription] = useState('');
  // Local number-meta for the create form (min/max/step/unit/control), seeded from `createNumberMeta`.
  const [newNumberMeta, setNewNumberMeta] = useState<PropNumberMeta>(createNumberMeta ?? {});
  // Type-picker ("+") state. `pendingTypeId` is set right after creating a typed variable so the
  // Default editor shows the right control immediately, before the mutation flush repopulates the list.
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pendingTypeId, setPendingTypeId] = useState<string | null>(null);
  const addBtnRef = useRef<HTMLButtonElement>(null);
  // Editable Name buffer (view mode). Committed (renamed) on blur/Enter.
  const [nameDraft, setNameDraft] = useState('');
  const nameInputRef = useRef<HTMLInputElement>(null);
  // Set when a variable is opened/created; the focus effect consumes it once the Name input mounts
  // (which for a just-created variable is only AFTER the create mutation flushes into the list).
  const focusNameFlag = useRef(false);

  const activeFile = useAtomValue(activeFilePathAtom);
  // Templates (LayoutClient.tsx) ARE component masters in the variable system:
  // their variables are function-signature props + @propMeta, exactly like a
  // design component. So the modal must take the COMPONENT path (purple accent +
  // deleteComponentVariable/renameComponentVariable mutations) for them too —
  // not the page path, which dispatches removePageVariable and never touches the
  // function signature (the bug where "Remove" did nothing on a template var).
  const isComponent = isComponentLikeFilePath(activeFile);
  const pageVariables = useAtomValue(pageVariablesAtom);
  // Bumps on every mutation flush. Without subscribing, the memos below read the
  // component code ONCE (on activeFile change) and go stale: a freshly-created
  // variable's binding isn't in that cached read yet, so its type can't be
  // resolved and the Default Value falls back to a plain text input until a
  // reload/page-switch re-reads the file. Re-reading on version bump fixes it.
  const projectVersion = useAtomValue(projectVersionAtom);

  // Accent colour follows the file convention: purple ("--accent-secondary")
  // signals "this affects the component master, edits propagate to all
  // instances". On regular pages there's no master/instance distinction —
  // the standard accent (blue) is the right cue. Same rule the variable
  // pill and the menu items already follow.
  const accentVar = isComponent ? 'var(--accent-secondary)' : 'var(--accent)';

  // ─── Existing variables ──────────────────────────────────────────────
  // On component master files: read from the component registry (function
  // signature props). On regular page files: read from @pageVariables —
  // ALL of them, regardless of type. Filtering by type compatibility used
  // to hide variables when the modal opened on a different property
  // (number variable invisible from a color slot, etc.), which made it
  // look like the variable wasn't created. Type compatibility is enforced
  // at bind time, not at list time.
  const existingVars = useMemo(() => {
    if (isComponent) {
      const registry = buildComponentRegistry(projectFS);
      for (const info of registry.values()) {
        // Exclude structural params (style / initialVariant / ref / …). They're
        // not user variables — binding a style to `initialVariant` hijacks the
        // variant SWITCHER and silently breaks variant animation. See
        // STRUCTURAL_PROPS for the full rationale.
        if (info.filePath === activeFile) return info.props.filter(p => !STRUCTURAL_PROPS.has(p.name));
      }
      // Templates aren't scanned into the `components/` registry — parse the
      // LayoutClient source directly so its variables (signature props +
      // @propMeta type/label) still populate the list, with the same structural
      // filter and full metadata a registry component would have.
      const tplCode = projectFS.readFile(activeFile) ?? '';
      const tplInfo = tplCode ? parseComponentInfoFromSource(activeFile, tplCode, String(tplCode.length)) : null;
      if (tplInfo) return tplInfo.props.filter(p => !STRUCTURAL_PROPS.has(p.name));
      return [] as ComponentProp[];
    }

    // Page files: union of @pageVariables AND any function-signature props.
    // The function-signature path catches variables created by an older
    // buggy code path (the unified ControlProvider used to dispatch
    // component-mutation even on regular pages, leaving the prop in the
    // signature instead of @pageVariables). Without this, those variables
    // are visible as bound on the canvas but invisible in the modal — the
    // user can't manage or remove them.
    const out: ComponentProp[] = pageVariables.map(v => ({ name: v.name, defaultValue: v.default, description: v.description }));
    const seen = new Set(out.map(p => p.name));
    const code = projectFS.readFile(activeFile) ?? '';
    const ast = parseJSX(code);
    if (ast) {
      const sigDefaults = extractComponentPropDefaults(ast);
      for (const [name, defaultValue] of Object.entries(sigDefaults)) {
        if (!seen.has(name) && !STRUCTURAL_PROPS.has(name)) {
          out.push({ name, defaultValue });
          seen.add(name);
        }
      }
    }
    return out;
  }, [activeFile, isComponent, pageVariables, projectVersion]);

  // ─── Reset state only when modal opens ────────────────────────────────
  useEffect(() => {
    if (!isOpen) return;
    if (manage) {
      // Breadcrumb entry point — browse the component's variables. No
      // property in scope, so open straight to the list.
      setMode('list');
      setSelectedVar(null);
    } else if (currentVariableRef) {
      setMode('view');
      setSelectedVar(currentVariableRef);
    } else {
      setMode('create');
      setSelectedVar(null);
    }
    setNewName(initialName ?? '');
    setDefaultValue(currentValue);
    setNewNumberMeta(createNumberMeta ?? {});
    setPendingTypeId(null);
    setPickerOpen(false);
    // Seed the description from the variable we're opening on (view mode), else blank (create).
    setDescription(currentVariableRef ? (existingVars.find(v => v.name === currentVariableRef)?.description ?? '') : '');
    setNameDraft(currentVariableRef ? (existingVars.find(v => v.name === currentVariableRef)?.label || currentVariableRef) : '');
    if (currentVariableRef) focusNameFlag.current = true;
  }, [isOpen, currentValue, initialName]);

  // Auto-focus + select the Name field once it's mounted (standard). Depends on `existingVars` so
  // it re-runs after a just-created variable flushes into the list and the input finally renders. The
  // one-shot flag stops it from stealing focus while the user is editing other fields.
  useEffect(() => {
    if (focusNameFlag.current && isOpen && nameInputRef.current) {
      focusNameFlag.current = false;
      nameInputRef.current.focus();
      nameInputRef.current.select();
    }
  }, [isOpen, selectedVar, existingVars]);

  // ─── Validation ──────────────────────────────────────────────────────
  const nameError = useMemo(() => {
    if (!newName) return null;
    if (!CAMEL_CASE_RE.test(newName)) return 'Must be camelCase (start lowercase, no spaces)';
    if (existingVars.some(v => v.name === newName)) return 'Variable name already exists';
    return null;
  }, [newName, existingVars]);

  const isNameValid = newName.length > 0 && nameError === null;

  // ─── Resolve control type for the CSS property ──────────────────────
  // In `manage`/browse mode there's no `property` in scope (the user is browsing every variable), so
  // each variable would fall back to a plain text input. Derive the property the SELECTED variable
  // drives from the component code (`localCssPropForVar` — handles direct / overlay / per-variant
  // ternary bindings) so e.g. a radius variable shows the Radius control, not a text box.
  const componentCode = useMemo(() => projectFS.readFile(activeFile) ?? '', [activeFile, projectVersion]);

  // VARIANT variable → a SELECT of the bound component's variants (parity with the Template
  // tool). The selected variable is a "variant variable" when an instance in the active file
  // binds it as the scroll-variant resting var (`fromVar`, base OR per-viewport
  // `responsive[scope].fromVar`) or directly as `initialVariant={var}`. Resolve that instance's
  // component → its variant list. Null when the variable doesn't drive a variant → plain editor.
  // Resolve which component's CODE a variant variable's variants come from — following BOTH a DIRECT
  // `initialVariant={var}` binding AND a FORWARDED prop chain (`<Header navVar={var}>` → inside Header
  // `<LogoMark initialVariant={navVar}>`), so a variant var hoisted through an INTERMEDIATE master
  // (TEMPLATE → Header → Logo Mark) resolves to the deepest component. Powers the Default variant SELECT
  // AND the list-row ICON (the option icon, not "T"). Falls back to @propMeta.variantOf for an UNBOUND var.
  const resolveVariantCompCode = useCallback((varName: string): string | null => {
    if (!componentCode || !varName) return null;
    const find = (code: string, filePath: string, propName: string, depth: number): string | null => {
      if (depth > 6) return null; // forwarding-chain guard
      let nodes: ReturnType<typeof parseJSXToNodes>;
      try { nodes = parseJSXToNodes(code); } catch { return null; }
      const imports = extractImports(code);
      const childCodeFor = (tag: string): { code: string; path: string } | null => {
        const src = imports.get(tag);
        const p = src ? resolveImportPath(src, filePath) : null;
        const c = p ? projectFS.readFile(p) : null;
        return (p && c) ? { code: c, path: p } : null;
      };
      for (const [id, node] of nodes) {
        // Direct binding of propName → this node's initialVariant (scroll-variant fromVar, plain attrPropRef,
        // per-viewport __mq variable, OR per-PARENT-VARIANT conditional variable branch).
        let boundToVariant = false;
        const sv = getScrollVariant(code, id);
        if (sv && (sv.fromVar === propName || (sv.responsive ?? []).some((r) => r.fromVar === propName))) boundToVariant = true;
        if (!boundToVariant && node.attrPropRefs?.['initialVariant'] === propName) boundToVariant = true;
        if (!boundToVariant && node.responsiveAttrPropVariables?.['initialVariant']
            && Object.values(node.responsiveAttrPropVariables['initialVariant']).includes(propName)) boundToVariant = true;
        if (!boundToVariant && node.attrConditionalVarRefs?.['initialVariant']
            && Object.values(node.attrConditionalVarRefs['initialVariant']).includes(propName)) boundToVariant = true;
        if (boundToVariant) {
          const child = childCodeFor(node.type);
          if (child && selectableVariants(parseVariantConfig(child.code)).length > 0) return child.code;
        }
        // FORWARDED: propName passed into some OTHER prop of this node → recurse into the child with it.
        const fwd = node.attrPropRefs
          ? Object.keys(node.attrPropRefs).find((k) => node.attrPropRefs![k] === propName && k !== 'initialVariant')
          : undefined;
        if (fwd) {
          const child = childCodeFor(node.type);
          if (child) {
            const deeper = find(child.code, child.path, fwd, depth + 1);
            if (deeper) return deeper;
          }
        }
      }
      return null;
    };
    try {
      const direct = find(componentCode, activeFile, varName, 0);
      if (direct) return direct;
      const variantOf = parsePropMeta(componentCode)[varName]?.variantOf;
      if (variantOf) {
        const importSrc = extractImports(componentCode).get(variantOf);
        const compPath = importSrc ? resolveImportPath(importSrc, activeFile) : null;
        return compPath ? projectFS.readFile(compPath) : null;
      }
    } catch { /* fall through */ }
    return null;
  }, [componentCode, activeFile]);

  const variantSelectOptions = useMemo<Array<{ value: string; label: string }> | null>(() => {
    if (!selectedVar) return null;
    const compCode = resolveVariantCompCode(selectedVar);
    if (!compCode) return null;
    // REAL variants only — interaction states (hover/pressed) are never selectable on an instance.
    const variants = selectableVariants(parseVariantConfig(compCode));
    return variants.length > 0 ? variants.map((v) => ({ value: v.name, label: v.label || v.name })) : null;
  }, [selectedVar, resolveVariantCompCode]);

  // Variant variables → the 'option'/select icon in the list, not the plain "T" (they carry @pageVariables
  // type 'text' and often no @propMeta.variantOf, so the type/binding icon resolver alone shows "T").
  const variantVarNameSet = useMemo(() => {
    const out = new Set<string>();
    for (const v of existingVars) { if (resolveVariantCompCode(v.name)) out.add(v.name); }
    return out;
  }, [existingVars, resolveVariantCompCode]);
  // Resolve a child instance tag (`<Tag …/>`) referenced in the host source → its source + path, for
  // `resolveVariableCssProp`'s forwarded-prop recursion (`<Child direction={var}/>` → Child's
  // `direction` → `flexDirection`). Same import→file→read hop the variant resolver above uses.
  const resolveChildCode = useCallback((childTag: string, parentCode: string, parentFilePath: string): ChildResolution | null => {
    const importSrc = extractImports(parentCode).get(childTag);
    const compPath = importSrc ? resolveImportPath(importSrc, parentFilePath) : null;
    const compCode = compPath ? projectFS.readFile(compPath) : null;
    return (compPath && compCode) ? { code: compCode, filePath: compPath } : null;
  }, []);

  // The picked TYPE of the selected variable (typed "+" variables). `pendingTypeId` covers the moment
  // right after creation (before the flush repopulates the list); otherwise read the stored varType.
  const activeTypeDef: VariableTypeDef | undefined = useMemo(() => {
    const id = pendingTypeId ?? (selectedVar ? existingVars.find(v => v.name === selectedVar)?.varType : undefined);
    return getVariableType(id);
  }, [pendingTypeId, selectedVar, existingVars]);

  /** Hide the Default row for no-default types (VariableTypeDef.noDefault:
   *  links, cursors). Fallback for LEGACY link variables created before the
   *  LinkTool stamped `varType: 'link'`: no declared type but the component
   *  binds them to an `href={…}` → same treatment. */
  const suppressDefaultRow = useMemo(() => {
    if (activeTypeDef) return !!activeTypeDef.noDefault;
    if (!selectedVar) return false;
    const safe = selectedVar.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`href=\\{[^}]*\\b${safe}\\b[^}]*\\}`).test(componentCode);
  }, [activeTypeDef, selectedVar, componentCode]);

  const effectiveProperty = useMemo(() => {
    // The actual BINDING is ground truth — resolve what the variable ACTUALLY drives FIRST (direct/overlay/
    // per-variant in the active file AND forwarded into a child instance prop, the hoisted case). A variable's
    // declared @propMeta/@pageVariables type can be WRONG (a `boxShadow` var was mis-inferred as `color`
    // because the cssProp matched /shadow/), and the type's controlProperty would then point the modal at a
    // colour picker instead of the Shadow editor. So the declared-type controlProperty + the explicit
    // `property` are FALLBACKS, used only when there's no live binding (orphan / freshly-created variable).
    if (selectedVar) {
      const fromCode = resolveVariableCssProp(selectedVar, componentCode, activeFile, resolveChildCode);
      if (fromCode) return fromCode;
    }
    // A typed variable whose editor reuses a style control points straight at that control's property.
    if (activeTypeDef?.editor === 'style' && activeTypeDef.controlProperty) return activeTypeDef.controlProperty;
    if (property) return property;
    if (!selectedVar) return '';
    // No live binding (orphan variable — unbound from every node but the prop/page-var is kept).
    // Infer the control from the stored default VALUE so we still show e.g. the color picker, not a
    // bare text box. A variable's identity shouldn't change just because it's not currently used.
    const def = existingVars.find(v => v.name === selectedVar)?.defaultValue ?? '';
    return inferPropertyFromValue(def);
  }, [activeTypeDef, property, selectedVar, componentCode, existingVars, activeFile, resolveChildCode]);
  const registryDef = useMemo(() => resolveControl(effectiveProperty), [effectiveProperty]);

  // ─── Handlers ────────────────────────────────────────────────────────
  const handleSelectVar = useCallback((name: string) => {
    setMode('view');
    setSelectedVar(name);
    setPendingTypeId(null); // use the stored varType from now on
    // Seed the editable default-value buffer so the view-mode editor is live (and smooth while
    // dragging) instead of round-tripping through a re-parse on every change.
    const v = existingVars.find(p => p.name === name);
    setDefaultValue(v?.defaultValue ?? '');
    setDescription(v?.description ?? '');
    setNameDraft(v?.label || name);
    focusNameFlag.current = true;
    trace.action('variable-modal:select', { name });
  }, [existingVars]);

  // Commit the Name field (blur / Enter). For COMPONENT variables the Name is a friendly display LABEL
  // (any string, e.g. "Overflow 2") stored in @propMeta — decoupled from the camelCase prop identifier,
  // so no risky rename. PAGE variables rename the identifier itself (camelCase, must be unique).
  const commitName = useCallback(() => {
    if (!selectedVar) return;
    const target = nameDraft.trim();
    const cur = existingVars.find(p => p.name === selectedVar);
    const currentDisplay = cur?.label || selectedVar;
    if (!target || target === currentDisplay) { setNameDraft(currentDisplay); return; }
    if (isComponent) {
      trace.action('variable-modal:set-label', { name: selectedVar, label: target });
      queueMutation({ type: 'setComponentPropLabel', propName: selectedVar, label: target });
      setNameDraft(target);
    } else {
      if (!CAMEL_CASE_RE.test(target) || existingVars.some(v => v.name === target)) { setNameDraft(currentDisplay); return; }
      trace.action('variable-modal:rename', { from: selectedVar, to: target });
      queueMutation({ type: 'updatePageVariable', oldName: selectedVar, updates: { name: target } });
      setSelectedVar(target);
      setNameDraft(target);
    }
  }, [selectedVar, nameDraft, existingVars, isComponent]);

  // "+" type picker → create a standalone TYPED variable (component prop) and open it for editing.
  // Generates a unique camelCase name from the type label (e.g. "Plain Text" → plainText, plainText1…).
  const handlePickType = useCallback((type: VariableTypeDef) => {
    setPickerOpen(false);
    // Prop IDENTIFIER: unique camelCase (e.g. plainText, plainText2). Display LABEL: the friendly type
    // name, unique with a " N" suffix (e.g. "Plain Text", "Plain Text 2").
    const base = type.label.replace(/[^a-zA-Z0-9]/g, '');
    const baseName = base.charAt(0).toLowerCase() + base.slice(1);
    const takenNames = new Set(existingVars.map(v => v.name));
    let name = baseName;
    for (let i = 1; takenNames.has(name); i++) name = `${baseName}${i}`;
    const takenLabels = new Set(existingVars.map(v => v.label || v.name));
    let label = type.label;
    for (let i = 2; takenLabels.has(label); i++) label = `${type.label} ${i}`;
    trace.action('variable-modal:create-typed', { name, type: type.id, label });
    queueMutation({ type: 'createTypedVariable', name, varType: type.id, literalKind: type.literalKind, defaultValue: type.defaultValue });
    queueMutation({ type: 'setComponentPropLabel', propName: name, label });
    flushNow(); // make the variable exist immediately so its editor renders without a staggered pop-in
    setSelectedVar(name);
    setPendingTypeId(type.id);
    setDefaultValue(type.defaultValue);
    setDescription('');
    setNameDraft(label);
    setMode('view');
    focusNameFlag.current = true;
  }, [existingVars]);

  // ─── Per-row ⋯ menu (Duplicate / Remove) ──────────────────────────────
  const [rowMenu, setRowMenu] = useState<{ name: string; x: number; y: number; bulk?: boolean; count?: number } | null>(null);
  // Multi-select for BULK delete — Shift+click = range, ⌘/Ctrl+click = toggle (mirrors the Library
  // + Presets panels). `anchorIdx` is the range pivot (the last plain-clicked row).
  const [selectedNames, setSelectedNames] = useState<Set<string>>(new Set());
  const [anchorIdx, setAnchorIdx] = useState<number | null>(null);

  // Variable-IN-USE guard (design-tool parity): a delete targeting variables still connected to nodes shows the
  // node list instead of deleting — the user removes the connections first. Click a node → select + zoom + close.
  const setSelectedIds = useSetAtom(selectedIdsAtom);
  const [removeWarning, setRemoveWarning] = useState<{ vars: string[]; nodes: { id: string; label: string; varName: string }[] } | null>(null);
  const getNodesUsing = useCallback((names: string[]) => {
    let code = projectFS.readFile(activeFile) ?? '';
    // Strip <style> blocks first: their CSS carries `[data-id="…"]` SELECTORS (per-viewport @media overrides),
    // NOT element tags. `openingTag` resolves a data-id via its FIRST `data-id="X"` occurrence — for an element
    // targeted by a @media rule that's its SELECTOR near the top of the JSX, so it extracted a garbage "tag"
    // that spilled into a LATER element (the CSS braces threw off the brace-depth walk), yielding phantom
    // matches all mislabeled as the nearby element (the user-reported "Logo Color used by 5 Headers").
    code = code.replace(/<style>[\s\S]*?<\/style>/g, '');
    // Match the variable ONLY in a VALUE position — a real binding references it as a bare identifier after a
    // value delimiter: `key: <name>` (style/object value), `cond ? <name> : …` / `… : <name>` (ternary),
    // `prop={<name>}` (JSX prop), or `"fromVar":"<name>"` (scroll-variant data-attr, quoted). The old
    // `(?<![\w$.])<name>(?![\w$])` matched the name ANYWHERE, so a variable NAMED after a CSS property
    // (`color`, `opacity`) lit up every node — it hit the CSS property KEY `color:` and the design token
    // `var(--color-…)`. Requiring a `: ? ={ :"` delimiter before excludes both (a key is `name:`, preceded
    // by `{`/`,`; a token is `--name`, preceded by `-`); forbidding `[\w$.-]` after keeps `color` from
    // matching `color-…`/`colorScheme`/`--color`.
    const targets = [...new Set(names)].map((n) => ({ name: n, re: new RegExp(`(?:[:?]\\s*"?|=\\{\\s*"?)${escRe(n)}(?![\\w$.-])`) }));
    const out: { id: string; label: string; varName: string }[] = [];
    const matched = new Set<string>();
    // 1) RAW opening-tag scan (drives off the CODE, not nodesAtom — works even when the parse is incomplete).
    //    Catches every style / prop / attr / per-viewport bool-nav / link / scroll-variant usage. data-id /
    //    data-name string values are stripped first so a node NAMED like a variable isn't a false positive.
    const idRe = /data-id="([^"]+)"/g; let m: RegExpExecArray | null; const seen = new Set<string>();
    while ((m = idRe.exec(code)) !== null) {
      const id = m[1]; if (seen.has(id)) continue; seen.add(id);
      const tag = openingTag(code, id); if (!tag) continue;
      const stripped = tag.replace(/\sdata-(?:id|name)="[^"]*"/g, '');
      for (const t of targets) {
        if (t.re.test(stripped)) { out.push({ id, label: tag.match(/data-name="([^"]*)"/)?.[1] || id, varName: t.name }); matched.add(id); break; }
      }
    }
    // 2) TEXT variables live in the node's CHILDREN (not the opening tag) → read them from the parsed nodes.
    for (const [id, node] of getNodesSnapshot()) {
      if (matched.has(id)) continue;
      const tv = (node as any).textVariable as string | undefined;
      if (tv && targets.some((t) => t.name === tv)) { out.push({ id, label: (node as any).name || id, varName: tv }); matched.add(id); }
    }
    return out;
  }, [activeFile, projectVersion]);
  const goToNode = useCallback((id: string) => {
    setSelectedIds([id]);
    onClose();
    // Defer so the modal unmounts + the selection commits before the camera move (mirrors Fit Selection).
    setTimeout(() => { const el = getContentRoot(); if (el) zoomToFitNodes(el, [id]); }, 60);
  }, [setSelectedIds, onClose]);
  useEffect(() => { if (!isOpen) setRemoveWarning(null); }, [isOpen]); // clear the guard when the modal closes

  // Remove a variable EVERYWHERE: drops the prop + strips every node binding that referenced it (so no
  // node points at a deleted variable). Component → deleteComponentVariable; page → removePageVariable.
  const handleRemoveVar = useCallback((name: string) => {
    setRowMenu(null);
    const using = getNodesUsing([name]);
    // In use → guard (don't delete). UNSELECT (no Dismiss button) — the warning shows until the user picks
    // another variable, which restores its edit panel.
    if (using.length > 0) { setSelectedNames(new Set()); setSelectedVar(null); setMode('list'); setRemoveWarning({ vars: [name], nodes: using }); return; }
    const v = existingVars.find(p => p.name === name);
    if (isComponent) {
      queueMutation({ type: 'deleteComponentVariable', propName: name, defaultValue: v?.defaultValue ?? '' });
      // Erase the HOIST TRAIL too: instances passing `name={pageVar}`, the now-orphaned
      // page/template variable in each instancing file, and a template's __templateProps
      // route values — else the Template tool keeps rendering an input for a variable
      // that no longer exists (deleted header var survived in the Body template, 2026-07-27).
      cascadeDeleteVariableUp(activeFile, name);
    } else {
      queueMutation({ type: 'removePageVariable', name });
    }
    if (selectedVar === name) { setSelectedVar(null); setPendingTypeId(null); setMode('list'); }
    trace.action('variable-modal:remove-var', { name });
  }, [existingVars, isComponent, selectedVar, getNodesUsing, activeFile]);

  // BULK remove every selected variable (multi-select → right-click "Remove N"). Reuses the SAME
  // per-variable mutations as `handleRemoveVar` so a bulk delete is identical to N single deletes.
  const handleRemoveMany = useCallback((names: string[]) => {
    setRowMenu(null);
    const using = getNodesUsing(names);
    // any in use → guard (lists ALL); unselect so the right panel is just the warning (no Dismiss button).
    if (using.length > 0) { setSelectedNames(new Set()); setSelectedVar(null); setMode('list'); setRemoveWarning({ vars: names, nodes: using }); return; }
    for (const name of names) {
      const v = existingVars.find(p => p.name === name);
      if (isComponent) {
        queueMutation({ type: 'deleteComponentVariable', propName: name, defaultValue: v?.defaultValue ?? '' });
        cascadeDeleteVariableUp(activeFile, name); // same hoist-trail erase as the single delete
      } else {
        queueMutation({ type: 'removePageVariable', name });
      }
      if (selectedVar === name) { setSelectedVar(null); setPendingTypeId(null); setMode('list'); }
    }
    setSelectedNames(new Set());
    setAnchorIdx(null);
    trace.action('variable-modal:remove-many', { count: names.length });
  }, [existingVars, isComponent, selectedVar, getNodesUsing, activeFile]);

  // Row click WITH multi-select: plain = single (select + edit), Shift = range from the anchor,
  // ⌘/Ctrl = toggle. A range/toggle is a bulk operation (clears the edit panel); a plain click edits.
  const handleRowClick = useCallback((e: React.MouseEvent, name: string, idx: number) => {
    setRemoveWarning(null); // selecting another variable dismisses the in-use guard
    if (e.shiftKey && anchorIdx !== null) {
      const lo = Math.min(anchorIdx, idx), hi = Math.max(anchorIdx, idx);
      setSelectedNames(new Set(existingVars.slice(lo, hi + 1).map(v => v.name)));
      setSelectedVar(null); setMode('list');
    } else if (e.metaKey || e.ctrlKey) {
      setSelectedNames(prev => { const n = new Set(prev); if (n.has(name)) n.delete(name); else n.add(name); return n; });
      setAnchorIdx(idx); setSelectedVar(null); setMode('list');
    } else {
      setSelectedNames(new Set([name]));
      setAnchorIdx(idx);
      handleSelectVar(name);
    }
  }, [anchorIdx, existingVars, handleSelectVar]);

  // Duplicate a variable as a new standalone copy — preserving ALL of its metadata (type, default,
  // label, description, Option choices, Number knobs), not just type+default. The new prop gets a fresh
  // camelCase id ("<name>Copy") but its display LABEL is "<original label> Copy" so the list shows a
  // sensible name instead of the raw id.
  const handleDuplicateVar = useCallback((name: string) => {
    setRowMenu(null);
    const v = existingVars.find(p => p.name === name);
    if (!v) return;
    const taken = new Set(existingVars.map(x => x.name));
    let newName = `${name}Copy`;
    for (let i = 1; taken.has(newName); i++) newName = `${name}Copy${i}`;
    if (isComponent) {
      const td = getVariableType(v.varType);
      queueMutation({ type: 'createTypedVariable', name: newName, varType: v.varType ?? '', literalKind: td?.literalKind ?? 'string', defaultValue: v.defaultValue ?? '' });
      // Carry over the rest of the @propMeta so the copy is a true duplicate.
      const origLabel = v.label || getPropLabel(componentCode, name) || name;
      queueMutation({ type: 'setComponentPropLabel', propName: newName, label: `${origLabel} Copy` });
      const desc = getPropDescription(componentCode, name);
      if (desc) queueMutation({ type: 'setComponentPropDescription', propName: newName, description: desc });
      const opts = getPropOptions(componentCode, name);
      if (opts.length) queueMutation({ type: 'setComponentPropOptions', propName: newName, options: opts });
      const numMeta = getPropNumberMeta(componentCode, name);
      if (Object.keys(numMeta).length) queueMutation({ type: 'setComponentPropNumberMeta', propName: newName, meta: numMeta });
    } else {
      const pv = pageVariables.find(p => p.name === name);
      if (pv) queueMutation({ type: 'addPageVariable', variable: { ...pv, name: newName } });
    }
    trace.action('variable-modal:duplicate-var', { name, newName });
  }, [existingVars, isComponent, pageVariables, componentCode]);

  // Persist a variable's description. Component variables write the `@propMeta` block; page variables
  // update the @pageVariables entry. Committed on blur (not per keystroke) to avoid a mutation storm.
  const persistDescription = useCallback((varName: string, desc: string) => {
    if (isComponent) {
      queueMutation({ type: 'setComponentPropDescription', propName: varName, description: desc });
    } else {
      queueMutation({ type: 'updatePageVariable', oldName: varName, updates: { description: desc } });
    }
    trace.action('variable-modal:set-description', { varName, hasDesc: !!desc.trim() });
  }, [isComponent]);

  // Persist an edit to the SELECTED variable's default value (view mode). Component variables write
  // the prop's signature default; page variables update the @pageVariables entry. Updates the local
  // buffer first for instant UI, then queues the code write (the queue coalesces rapid drag edits).
  const handleViewDefaultChange = useCallback((v: string) => {
    setDefaultValue(v);
    if (!selectedVar) return;
    if (isComponent) {
      queueMutation({ type: 'setComponentPropDefault', propName: selectedVar, newDefault: v, literalKind: activeTypeDef?.literalKind });
      // A TEMPLATE/layout carries each variable as BOTH a function param (the runtime value) AND a
      // @pageVariables entry (the modal's list). setComponentPropDefault only touches the param, so the
      // two DIVERGE (param='variant-2', @pageVariables='default') — and the canvas can resolve the stale
      // @pageVariables default (it's folded into propOverrides), rendering the wrong variant. Keep them in
      // sync. No-op for a PURE component (the var isn't in @pageVariables).
      if (pageVariables.some((p) => p.name === selectedVar)) {
        queueMutation({ type: 'updatePageVariable', oldName: selectedVar, updates: { default: v } });
      }
    } else {
      queueMutation({ type: 'updatePageVariable', oldName: selectedVar, updates: { default: v } });
    }
    // Modal-initiated change: unlike a canvas drag, no `patchStyles` was sent to the iframe, so the
    // flush's `onBeforeFlush` would set `canvasUpdating` and the post-flush render would be SKIPPED —
    // the new default (which flows into every node bound to this variable) never reaches the canvas
    // until a page switch. setForceRender() tells onBeforeFlush to let the render through. See
    // CanvasRenderer.render()'s canvasUpdating skip + node-ops solo-replica-clear for the same pattern.
    setForceRender();
  }, [selectedVar, isComponent, activeTypeDef, pageVariables]);

  const handleCreate = useCallback(() => {
    if (!isNameValid) return;
    trace.action('variable-modal:create', { property, name: newName, defaultValue, number: !!createNumberMeta });
    onCreateVariable?.(newName, defaultValue, createNumberMeta ? newNumberMeta : undefined);
    // Persist the description AFTER creation (the prop/page-var now exists; the queue preserves order).
    if (description.trim()) persistDescription(newName, description);
    onClose();
  }, [isNameValid, property, newName, defaultValue, description, persistDescription, onCreateVariable, onClose, createNumberMeta, newNumberMeta]);

  // ─── Debug trace (only when visible) ─────────────────────────────────
  if (isOpen) {
    trace.fn('VariableModal:render', { property, mode, varCount: existingVars.length });
  }

  // ─── Default value control renderer ──────────────────────────────────
  // Order of preference:
  //   1. Atom from variable-editor-registry (real Shadow/Filter/Padding/etc.
  //      editor mounted in `variableDefault` mode — same UI as the right panel)
  //   2. Numeric/select/text fallback from control-registry
  //
  // The atom path is what makes this modal context-aware: the user gets the
  // exact editor they'd use to set the value on a node, just operating on a
  // local buffer instead of node styles.
  const VariableEditorAtom = useMemo(() => resolveVariableEditor(effectiveProperty), [effectiveProperty]);

  const renderDefaultValueControl = (value: string, onChange: (v: string) => void) => {
    // LIVE drag preview: imperatively patch the canvas nodes bound to THIS variable per frame (color /
    // border-width / slider) instead of committing code every move. `onChange` still commits once on
    // pointer-up. No-op for a brand-new var (selectedVar null → previewVar finds no bindings). Mirrors the
    // Template tool's `live` handler — the shorthand atoms route here via the provider's onChangeMultipleLive.
    const live = (v: string) => onPreviewLive?.(selectedVar ?? '', v);
    // Caller-supplied editor wins — used for Code component `@control` variables where
    // there's no CSS property to derive a control from.
    if (renderDefaultValue) {
      return renderDefaultValue(value, onChange);
    }

    // Variant variable → the bound component's variant SELECT (not a bare text input).
    if (variantSelectOptions && variantSelectOptions.length > 0) {
      return <ToolSelect value={value || variantSelectOptions[0]?.value || ''} onChange={onChange} options={variantSelectOptions} />;
    }

    // A GENERIC-typed variable (plainText/formattedText — e.g. a page var or a hoisted var) that DRIVES
    // a property with a DEDICATED control atom (flexDirection → DirectionControl arrows, overflow → …)
    // renders THAT atom — not the bare text box its `'text'` type would otherwise pick. This is what
    // makes the modal match every other surface for a hoisted Direction variable. (Typed color/number/
    // option/toggle variables keep their own editors in the switch below; 'style' types fall to the atom
    // path anyway.) Checked here, before the type switch, because the type alone would win otherwise.
    if (VariableEditorAtom && (!activeTypeDef || activeTypeDef.editor === 'text' || activeTypeDef.editor === 'textarea')) {
      return (
        <UnifiedControlProvider property={effectiveProperty} mode="variableDefault" externalValue={value} externalOnChange={onChange} externalOnChangeLive={live} hideLabel>
          <VariableEditorAtom mode="variableDefault" externalValue={value} externalOnChange={onChange} externalOnChangeLive={live} hideLabel />
        </UnifiedControlProvider>
      );
    }

    // Typed "+" variables with a PRIMITIVE editor (data types). 'style' types fall through to the
    // control-registry path below (effectiveProperty already points at the control's CSS property).
    if (activeTypeDef && activeTypeDef.editor !== 'style') {
      switch (activeTypeDef.editor) {
        case 'none':
          return <p className="text-xs text-[var(--text-secondary)] py-1.5">No default — an event is wired on the instance.</p>;
        case 'componentCursor':
          // The full Component Cursor control needs a node context, so the cursor pill supplies it via
          // `renderDefaultValue` (handled at the top). Reaching here means we were opened without that
          // context (the breadcrumb browser) — show a hint.
          return <p className="text-xs text-[var(--text-secondary)] py-1.5">Edit this cursor from the element's Cursor row.</p>;
        case 'toggle':
          return (
            <ToolSegmentedControl
              value={value === 'true' ? 'true' : 'false'}
              onChange={onChange}
              options={[{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }]}
              size="sm"
            />
          );
        case 'number': {
          // A Number variable's value is a RAW number. Strip any unit a legacy/stale default carried
          // (e.g. a fontSize var created before fontSize→number minted `= '16px'`) so the editor shows
          // "16", not "16px" — and the next edit re-commits it as a clean numeric literal. New variables
          // are already raw (createVariableInCode writes `= 16`), so this is a no-op for them.
          const num = parseFloat(value);
          const cleanVal = Number.isFinite(num) ? String(num) : value;
          return <NumberVariableEditor value={cleanVal} onChange={onChange} meta={selectedVar ? getPropNumberMeta(componentCode, selectedVar) : undefined} />;
        }
        case 'textarea':
          return <AutoGrowTextarea value={value} onChange={onChange} placeholder="Default value" />;
        case 'option': {
          if (!selectedVar) return null;
          const optionVals = getPropOptions(componentCode, selectedVar);
          // LOCKED CSS-enum options (justify/align/wrap/…) → a plain, non-editable select: the values
          // are fixed by the CSS property, so the add/edit/remove list would let the user break it.
          if (getPropOptionsLocked(componentCode, selectedVar)) {
            return <ToolSelect value={value} onChange={onChange} options={optionVals.map((o) => ({ value: o, label: o }))} />;
          }
          return <OptionDefaultEditor varName={selectedVar} value={value} onChange={onChange} options={optionVals} />;
        }
        default: // 'text' — plainText / date / link / image / file / cursor / transition
          return <ToolInput value={value} onChange={onChange} text />;
      }
    }
    if (VariableEditorAtom) {
      return (
        // NOTE: the atom (FillControl/ShadowControl/…) re-wraps in its OWN UnifiedControlProvider and
        // spreads `...mp` into it — so `hideLabel` MUST be passed as a prop to the ATOM (it flows through
        // `...mp` to the inner context). Setting it only on this outer provider is shadowed by the atom's
        // inner one. We keep it on both: the atom's inner wins, the outer covers any non-self-wrapping atom.
        <UnifiedControlProvider
          property={effectiveProperty}
          mode="variableDefault"
          externalValue={value}
          externalOnChange={onChange}
          externalOnChangeLive={live}
          hideLabel
        >
          <VariableEditorAtom mode="variableDefault" externalValue={value} externalOnChange={onChange} externalOnChangeLive={live} hideLabel />
        </UnifiedControlProvider>
      );
    }

    if (registryDef?.type === 'numeric') {
      const numValue = parseFloat(value) || 0;
      const unit = value.replace(/^-?[\d.]+/, '') || 'px';
      return (
        <div className="flex items-center gap-2 w-full">
          <ToolSlider
            value={numValue}
            min={registryDef.min ?? 0}
            max={registryDef.max ?? 100}
            step={registryDef.step ?? 1}
            onChange={(v) => onChange(`${v}${unit}`)}
          />
          <ToolInput
            value={value}
            onChange={onChange}
            step={registryDef.step ?? 1}
          />
        </div>
      );
    }

    if (registryDef?.type === 'select') {
      return (
        <ToolSelect
          value={value}
          onChange={onChange}
          options={registryDef.options}
        />
      );
    }

    return <ToolInput value={value} onChange={onChange} text />;
  };

  // ─── Selected variable info ──────────────────────────────────────────
  const selectedVarInfo = selectedVar
    ? existingVars.find(v => v.name === selectedVar) ?? null
    : null;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Variables"
      width={600}
      // On component files the "+" is the only header control (× removed — close via Escape / backdrop).
      hideClose={isComponent}
      // "+" type picker — component files only (typed props). On page files, variables are typed
      // page-variables managed elsewhere; the per-style "Create" flow on the left still applies.
      headerAction={isComponent ? (
        <button
          ref={addBtnRef}
          onClick={() => setPickerOpen(o => !o)}
          title="Add a variable"
          className="p-1 hover:bg-[var(--bg-hover)] cut-corners transition-colors cursor-pointer text-[var(--text-secondary)]"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
      ) : undefined}
    >
      {pickerOpen && (
        <VariableTypePicker anchorRef={addBtnRef} onSelect={handlePickType} onClose={() => setPickerOpen(false)} />
      )}
      {/* Per-row ⋯ menu — same dropdown style as ControlLabel's menu (accent-hover inset rows). */}
      {rowMenu && createPortal(
        <div className="fixed inset-0" style={{ zIndex: 100021 }} onMouseDown={() => setRowMenu(null)}>
          <div
            className="absolute bg-[var(--dropdown-bg)] shadow-[var(--shadow-lg)] cut-corners cut-lg cut-border [--cut-border-color:var(--border-light)] py-1.5 min-w-[160px] border border-[var(--border-light)] space-y-0.5"
            style={{ top: rowMenu.y, left: Math.max(8, rowMenu.x - 160) }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            {/* Hover accent follows the file convention: blue on a page, purple
                only inside a component/template master (accentVar). Tailwind can't
                interpolate a JS value into `hover:bg-[…]`, so route it through a
                local CSS var the hover utility reads. */}
            {rowMenu.bulk ? (
              // Multi-select → ONE action: delete every selected variable at once.
              <button
                onClick={() => handleRemoveMany([...selectedNames])}
                style={{ ['--row-accent' as string]: accentVar } as React.CSSProperties}
                className="group flex items-center mx-1.5 px-2.5 py-1.5 cut-corners w-[calc(100%-12px)] text-left cursor-pointer text-xs text-[var(--text-primary)] hover:bg-[var(--row-accent)] hover:text-white transition-colors"
              >
                Remove {rowMenu.count} variables
              </button>
            ) : (
              <>
                <button
                  onClick={() => handleDuplicateVar(rowMenu.name)}
                  style={{ ['--row-accent' as string]: accentVar } as React.CSSProperties}
                  className="group flex items-center mx-1.5 px-2.5 py-1.5 cut-corners w-[calc(100%-12px)] text-left cursor-pointer text-xs text-[var(--text-primary)] hover:bg-[var(--row-accent)] hover:text-white transition-colors"
                >
                  Duplicate
                </button>
                <button
                  onClick={() => handleRemoveVar(rowMenu.name)}
                  style={{ ['--row-accent' as string]: accentVar } as React.CSSProperties}
                  className="group flex items-center mx-1.5 px-2.5 py-1.5 cut-corners w-[calc(100%-12px)] text-left cursor-pointer text-xs text-[var(--text-primary)] hover:bg-[var(--row-accent)] hover:text-white transition-colors"
                >
                  Remove
                </button>
              </>
            )}
          </div>
        </div>,
        document.body,
      )}
      <div className="flex" style={{ minHeight: '420px', maxHeight: '60vh' }}>

        {/* ─── Left Panel ─────────────────────────────────────────── */}
        {/* No "Create new …" button: creation happens from the caller ("Create Variable" on a control
            label creates immediately; the header "+" adds a typed variable) and this modal is purely the
            manage surface (list + edit + remove), mirroring the header-opened "Variables" modal. */}
        {/* select-none on the whole panel: Shift-click range-select must NOT paint the
            browser's native blue text selection across the multi-selected row labels. */}
        <div className="w-64 border-r border-[var(--border-light)] flex flex-col select-none">

          {/* Variable list */}
          <div className="overflow-y-auto flex-1 scrollbar-hide">
            {existingVars.length === 0 ? (
              <div className="px-4 py-8 text-center text-[var(--text-secondary)]">
                <p className="text-xs">No variables created yet</p>
                <p className="text-xs mt-1 opacity-60">Click on a style name on the properties toolbar to create a variable for that style</p>
              </div>
            ) : (
              <div className="flex flex-col gap-0.5 py-2">
                {existingVars.map((v, idx) => {
                  const isSelected = (selectedVar === v.name && mode === 'view') || selectedNames.has(v.name);
                  // A GENERIC declared type ('text'/'plainText' → the "T" icon) is the FALLBACK type — a
                  // border/shadow var stored as type 'text' (no @propMeta type) must show its REAL icon,
                  // resolved from the BINDING/value, not "T". A SPECIFIC type wins outright; for a generic
                  // type, use the binding/value icon ONLY if it resolves to something specific, else keep "T"
                  // (a true plain-text var). pageVarType is NOT passed — typeIcon covers the declared type, and
                  // a generic 'text' there would short-circuit the binding resolution.
                  const typeIcon = getVariableType(v.varType)?.iconKey;
                  const boundIcon = resolveVariableIconKey({
                    property: isComponent ? resolveVariableCssProp(v.name, componentCode, activeFile, resolveChildCode) : undefined,
                    value: v.defaultValue ?? '',
                  });
                  // A variant variable → the 'option'/select icon (it drives a component's variants), even
                  // when its declared type is the generic 'text' and it carries no @propMeta.variantOf.
                  const iconKey = variantVarNameSet.has(v.name)
                    ? 'option'
                    : (typeIcon && typeIcon !== 'text')
                      ? typeIcon
                      : (boundIcon !== 'generic' ? boundIcon : (typeIcon ?? 'generic'));
                  return (
                    <div
                      key={v.name}
                      ref={isSelected ? selectedRowRef : undefined}
                      // The WHOLE row is the select target (incl. the px-2/py-1.5
                      // padding) — previously the onClick sat on the inner button,
                      // leaving the top/bottom padding strips dead.
                      onClick={(e) => handleRowClick(e, v.name, idx)}
                      // Right-click: on a row that's part of a MULTI selection → the bulk "Remove N"
                      // menu; otherwise select just this row + the single ⋯ menu (Duplicate / Remove).
                      onContextMenu={(e) => {
                        e.preventDefault();
                        if (selectedNames.has(v.name) && selectedNames.size > 1) {
                          setRowMenu({ name: v.name, x: e.clientX + 160, y: e.clientY, bulk: true, count: selectedNames.size });
                        } else {
                          setSelectedNames(new Set([v.name]));
                          setRowMenu({ name: v.name, x: e.clientX + 160, y: e.clientY });
                        }
                      }}
                      className={`group flex items-center gap-2 px-2 py-1.5 cut-corners cut-border mx-2 text-[var(--text-primary)] border cursor-pointer ${
                        isSelected
                          ? 'bg-[var(--bg-hover)] border-[var(--border-light)] [--cut-border-color:var(--border-light)]'
                          : 'border-transparent [--cut-border-color:transparent] hover:bg-[var(--bg-hover)]'
                      }`}
                    >
                      {/* Presentational wrapper — fills the row and pushes ⋯ to the
                       *  right. Click handling lives on the parent row above. */}
                      <div className="flex items-center gap-2 flex-1 min-w-0 text-left">
                        <span
                          className="w-[18px] h-[18px] rounded flex items-center justify-center flex-shrink-0 text-white"
                          style={{ backgroundColor: accentVar }}
                        >
                          <VariableTypeIcon iconKey={iconKey} size={11} />
                        </span>
                        <span className="flex-1 min-w-0 text-xs truncate">{v.label || v.name}</span>
                      </div>
                      {/* Hover ⋯ → Duplicate / Remove menu */}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                          setRowMenu({ name: v.name, x: r.right, y: r.bottom + 4 });
                        }}
                        className={`shrink-0 p-0.5 cut-corners hover:bg-[var(--bg-active)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-opacity ${
                          rowMenu?.name === v.name ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                        }`}
                        title="More"
                      >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* ─── Right Panel ────────────────────────────────────────── */}
        <div className="flex-1 flex flex-col">

          {/* IN-USE guard — takes over the right panel (the list stays, selected var highlighted). Lists every
              connected element (across ALL targeted vars for a multi-select). Click a row → select + zoom +
              close so the user can remove the connection there; come back and the delete proceeds. design-tool parity. */}
          {removeWarning && (
            <div className="flex-1 flex flex-col p-4 min-w-0 overflow-hidden">
              <div className="text-xs font-semibold text-[var(--text-primary)]">
                {removeWarning.vars.length === 1
                  ? `${existingVars.find(p => p.name === removeWarning.vars[0])?.label || removeWarning.vars[0]} is in use`
                  : `${removeWarning.vars.length} variables in use`}
              </div>
              <div className="text-[11px] text-[var(--text-secondary)] mt-1 leading-snug">
                Used by the {removeWarning.nodes.length === 1 ? 'element' : 'elements'} below — disconnect {removeWarning.vars.length === 1 ? 'it' : 'them'} there before removing.
              </div>
              <div className="flex flex-col mt-3 flex-1 overflow-y-auto scrollbar-hide">
                {removeWarning.nodes.map((n) => (
                  <button
                    key={`${n.id}:${n.varName}`}
                    onClick={() => goToNode(n.id)}
                    className="group flex items-center justify-between gap-2 py-1.5 border-b border-[var(--border-light)] text-left cursor-pointer transition-opacity hover:opacity-70"
                  >
                    <span className="text-xs text-[var(--text-primary)] truncate">{n.label}</span>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-[var(--text-secondary)]">
                      <polyline points="9 18 15 12 9 6" />
                    </svg>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* List mode — empty state */}
          {!removeWarning && mode === 'list' && (
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center text-[var(--text-secondary)]">
                <p className="text-xs">Select a variable{manage ? '' : ' or create a new one'}</p>
                <p className="text-xs mt-1 opacity-60">
                  {manage
                    ? 'These are the variables defined on this component'
                    : 'Click on a style name to create a variable'}
                </p>
              </div>
            </div>
          )}

          {/* Create mode — form */}
          {!removeWarning && mode === 'create' && (
            <>
              <div className="flex-1 p-6 overflow-y-auto space-y-2">
                {/* Name */}
                <FieldRow label="Name">
                  <input
                    type="text"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder="e.g. cardGap"
                    autoFocus
                    className={`w-full h-[var(--control-height)] px-3 text-xs bg-[var(--grid-line)] cut-corners cut-border text-[var(--text-primary)] focus:outline-none transition-colors ${
                      nameError
                        ? 'border border-red-500 [--cut-border-color:#ef4444] focus:border-red-500 focus:[--cut-border-color:#ef4444]'
                        : 'border border-[var(--border-light)] [--cut-border-color:var(--border-light)] hover:border-[var(--control-border)] hover:[--cut-border-color:var(--control-border)] focus:border-[var(--border-focus)] focus:[--cut-border-color:var(--border-focus)]'
                    }`}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && isNameValid) handleCreate();
                    }}
                  />
                  {nameError && (
                    <p className="text-xs text-red-500 mt-1">{nameError}</p>
                  )}
                </FieldRow>

                {/* Description */}
                <FieldRow label="Description" align="start">
                  <AutoGrowTextarea value={description} onChange={setDescription} minRows={3} />
                </FieldRow>

                {/* Default value — hidden for no-default variable types (links,
                    cursors — see VariableTypeDef.noDefault). */}
                {!hideDefault && !suppressDefaultRow && (
                  <FieldRow label="Default" align="start">
                    <div className="flex flex-col gap-2">
                      {renderDefaultValueControl(defaultValue, setDefaultValue)}
                    </div>
                  </FieldRow>
                )}

                {/* Number variable — the FULL config (Min/Max/Step/Unit/Control), same editor as a Number
                    variable created from opacity/gap. Seeded from the source control so the new variable
                    is a complete, interchangeable Number type. */}
                {createNumberMeta && (
                  <NumberMetaFields
                    meta={newNumberMeta}
                    patch={(m) => setNewNumberMeta(prev => {
                      const next = { ...prev };
                      for (const [k, v] of Object.entries(m)) {
                        if (v === null || v === undefined) delete (next as Record<string, unknown>)[k];
                        else (next as Record<string, unknown>)[k] = v;
                      }
                      return next;
                    })}
                  />
                )}
              </div>

              {/* Action buttons */}
              <div className="border-t border-[var(--border-light)] p-4 flex justify-end gap-2">
                <button
                  onClick={() => { setMode('list'); setSelectedVar(null); }}
                  className="px-4 h-[var(--control-height-sm)] text-xs bg-[var(--control-bg)] text-[var(--text-primary)] border border-[var(--border-light)] cut-corners cut-border [--cut-border-color:var(--border-light)] hover:bg-[var(--bg-hover)] transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleCreate}
                  disabled={!isNameValid}
                  className="px-4 h-7 text-xs text-white cut-corners hover:brightness-110 transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:brightness-100"
                  style={{ backgroundColor: accentVar }}
                >
                  Create Variable
                </button>
              </div>
            </>
          )}

          {/* View mode — variable details */}
          {!removeWarning && mode === 'view' && selectedVarInfo && (
            <>
              <div className="flex-1 p-6 overflow-y-auto space-y-2">
                {/* Name — editable; renames the variable (prop + all refs) on blur / Enter. */}
                <FieldRow label="Name">
                  <input
                    ref={nameInputRef}
                    type="text"
                    value={nameDraft}
                    onChange={(e) => setNameDraft(e.target.value)}
                    onBlur={commitName}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitName(); (e.target as HTMLInputElement).blur(); } }}
                    placeholder="Variable name"
                    className="w-full h-[var(--control-height)] px-3 text-xs bg-[var(--grid-line)] text-[var(--text-primary)] border border-[var(--border-light)] cut-corners cut-border [--cut-border-color:var(--border-light)] hover:[--cut-border-color:var(--control-border)] focus:[--cut-border-color:var(--border-focus)] hover:border-[var(--control-border)] focus:border-[var(--border-focus)] focus:outline-none transition-colors"
                  />
                </FieldRow>

                {/* Description — editable, committed on blur */}
                <FieldRow label="Description" align="start">
                  <AutoGrowTextarea
                    value={description}
                    onChange={setDescription}
                    onBlur={() => persistDescription(selectedVarInfo.name, description)}
                    minRows={3}
                  />
                </FieldRow>

                {/* Default value — hidden for no-default variable types (links,
                    cursors — see VariableTypeDef.noDefault). */}
                {!hideDefault && !suppressDefaultRow && (
                  <FieldRow label="Default" align="start">
                    <div className="flex flex-col gap-2">
                      {renderDefaultValueControl(
                        defaultValue,            // editable buffer (seeded on select)
                        handleViewDefaultChange, // persists to the variable's default
                      )}
                    </div>
                  </FieldRow>
                )}

                {/* Number knobs (Min / Max / Step / Unit / Control) — the reference ControlType.Number config. */}
                {activeTypeDef?.id === 'number' && isComponent && (
                  <NumberMetaConfig varName={selectedVarInfo.name} componentCode={componentCode} />
                )}
              </div>

            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
