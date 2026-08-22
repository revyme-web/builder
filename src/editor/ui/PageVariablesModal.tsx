// PageVariablesModal.tsx — Manage page-level variables (standard typed primitives).
//
// Two-panel modal:
//   Left  — list of variables on the active page + "+ New variable" button
//   Right — create or edit/view form (name, type, default value, optional queryParam)
//
// Variables are typed primitives (number, text, boolean, color). The default
// value control adapts to the type — slider for number, color picker for color,
// segmented yes/no for boolean, plain text input otherwise.
//
// Hidden on component master files (those use props instead) — the trigger
// gates by isComponent before opening this modal, but the modal itself also
// renders an explanatory message if reached on a component file just in case.

import { useState, useMemo, useEffect, useCallback } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import Modal from '@/design-system/Modal';
import ColorInput from '../controls/ColorInput';
import ImagePickerInput from '../controls/ImagePickerInput';
import { ToolInput, ToolSegmentedControl, ToolSlider } from '../controls';
import { activeFilePathAtom, isComponentFilePath } from '@/code/project/active-file-store';
import { pageVariablesAtom, pageVariablesModalOpenAtom } from '@/code/stores/page-variables-store';
import { defaultForType, type PageVariable, type PageVariableType } from '@/code/features/page-variables';
import { queueMutation } from '@/code/mutation/mutation-queue';
import { VariableTypeIcon, resolveVariableIconKey } from '../controls/VariableTypeIcon';
import { trace } from '@/shared/debug-trace';

// ─── Types & constants ──────────────────────────────────────────────────────

type Mode = 'create' | 'view' | 'empty';

const CAMEL_CASE_RE = /^[a-z][a-zA-Z0-9]*$/;

const TYPE_OPTIONS: Array<{ value: PageVariableType; label: string }> = [
  { value: 'number',  label: 'Number'  },
  { value: 'text',    label: 'Text'    },
  { value: 'boolean', label: 'Boolean' },
  { value: 'color',   label: 'Color'   },
  { value: 'image',   label: 'Image'   },
];

// ─── Component ──────────────────────────────────────────────────────────────

export default function PageVariablesModal() {
  const isOpen = useAtomValue(pageVariablesModalOpenAtom);
  const setIsOpen = useSetAtom(pageVariablesModalOpenAtom);
  const activeFile = useAtomValue(activeFilePathAtom);
  const isComponent = isComponentFilePath(activeFile);
  const variables = useAtomValue(pageVariablesAtom);

  const onClose = useCallback(() => setIsOpen(false), [setIsOpen]);

  const [mode, setMode] = useState<Mode>('empty');
  const [selectedName, setSelectedName] = useState<string | null>(null);

  // Form state — used in both create and view/edit
  const [draftName, setDraftName] = useState('');
  const [draftType, setDraftType] = useState<PageVariableType>('number');
  const [draftDefault, setDraftDefault] = useState('1');
  const [draftQueryParam, setDraftQueryParam] = useState('');

  // ─── Reset state on open ─────────────────────────────────────────────
  useEffect(() => {
    if (!isOpen) return;
    if (variables.length > 0) {
      // Open the first variable for view by default
      const first = variables[0];
      setMode('view');
      setSelectedName(first.name);
      seedFormFromVariable(first);
    } else {
      setMode('create');
      setSelectedName(null);
      seedFormForCreate('number');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  function seedFormFromVariable(v: PageVariable) {
    setDraftName(v.name);
    setDraftType(v.type);
    setDraftDefault(v.default);
    setDraftQueryParam(v.queryParam ?? '');
  }

  function seedFormForCreate(type: PageVariableType) {
    setDraftName('');
    setDraftType(type);
    setDraftDefault(defaultForType(type));
    setDraftQueryParam('');
  }

  // ─── Selected variable lookup ────────────────────────────────────────
  const selected = useMemo(
    () => (selectedName ? variables.find(v => v.name === selectedName) ?? null : null),
    [selectedName, variables],
  );

  // ─── Validation ──────────────────────────────────────────────────────
  const nameError = useMemo(() => {
    if (!draftName) return null;
    if (!CAMEL_CASE_RE.test(draftName)) return 'Must be camelCase (start lowercase, no spaces).';
    // In create mode: any existing name conflicts
    // In view mode: only conflicts with names other than the one being edited
    const conflictWith = mode === 'view' ? selectedName : null;
    if (variables.some(v => v.name === draftName && v.name !== conflictWith)) return 'A variable with that name already exists.';
    return null;
  }, [draftName, variables, mode, selectedName]);

  const queryParamError = useMemo(() => {
    if (!draftQueryParam) return null;
    if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(draftQueryParam)) return 'Letters, numbers, dashes and underscores only.';
    return null;
  }, [draftQueryParam]);

  const isValid = draftName.length > 0 && nameError === null && queryParamError === null;
  const dirty = mode === 'view' && selected && (
    selected.name !== draftName ||
    selected.type !== draftType ||
    selected.default !== draftDefault ||
    (selected.queryParam ?? '') !== draftQueryParam
  );

  // ─── Handlers ────────────────────────────────────────────────────────
  const handleSelectVariable = useCallback((name: string) => {
    const v = variables.find(x => x.name === name);
    if (!v) return;
    trace.action('page-vars-modal:select', { name });
    setMode('view');
    setSelectedName(name);
    seedFormFromVariable(v);
  }, [variables]);

  const handleStartCreate = useCallback(() => {
    trace.action('page-vars-modal:start-create');
    setMode('create');
    setSelectedName(null);
    seedFormForCreate('number');
  }, []);

  const handleCreate = useCallback(() => {
    if (!isValid) return;
    const variable: PageVariable = {
      name: draftName,
      type: draftType,
      default: draftDefault,
    };
    if (draftQueryParam) variable.queryParam = draftQueryParam;
    trace.action('page-vars-modal:create', variable);
    queueMutation({ type: 'addPageVariable', variable });
    // Switch into view mode for the freshly-created variable so the user can
    // continue tweaking it without closing the modal.
    setMode('view');
    setSelectedName(draftName);
  }, [isValid, draftName, draftType, draftDefault, draftQueryParam]);

  const handleSave = useCallback(() => {
    if (!isValid || !selected || !dirty) return;
    const updates: Partial<PageVariable> = {};
    if (selected.name !== draftName) updates.name = draftName;
    if (selected.type !== draftType) updates.type = draftType;
    if (selected.default !== draftDefault) updates.default = draftDefault;
    if ((selected.queryParam ?? '') !== draftQueryParam) updates.queryParam = draftQueryParam;
    trace.action('page-vars-modal:save', { oldName: selected.name, updates });
    queueMutation({ type: 'updatePageVariable', oldName: selected.name, updates });
    setSelectedName(draftName); // follow the rename
  }, [isValid, dirty, selected, draftName, draftType, draftDefault, draftQueryParam]);

  const handleRemove = useCallback(() => {
    if (!selected) return;
    trace.action('page-vars-modal:remove', { name: selected.name });
    queueMutation({ type: 'removePageVariable', name: selected.name });
    // Move selection to whatever's left, or fall to create mode if the list is now empty.
    const remaining = variables.filter(v => v.name !== selected.name);
    if (remaining.length > 0) {
      setMode('view');
      setSelectedName(remaining[0].name);
      seedFormFromVariable(remaining[0]);
    } else {
      setMode('create');
      setSelectedName(null);
      seedFormForCreate('number');
    }
  }, [selected, variables]);

  // When the user changes type mid-form, reset default to the type's default —
  // a "1" number doesn't make sense as a color, etc.
  const handleTypeChange = useCallback((newType: string) => {
    const t = newType as PageVariableType;
    setDraftType(t);
    setDraftDefault(defaultForType(t));
  }, []);

  if (isOpen) trace.fn('PageVariablesModal:render', { mode, varCount: variables.length, isComponent });

  // ─── Render ──────────────────────────────────────────────────────────
  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Page Variables" width={620}>
      {isComponent ? (
        <div className="p-8 text-center text-[var(--text-secondary)]">
          <p className="text-xs">Page variables aren't available on component files.</p>
          <p className="text-xs mt-2 opacity-60">
            Components use props instead — set them via the Properties panel.
          </p>
        </div>
      ) : (
        <div className="flex" style={{ minHeight: '440px', maxHeight: '60vh' }}>

          {/* ─── Left panel ────────────────────────────────────────── */}
          <div className="w-56 border-r border-[var(--border-light)] flex flex-col">
            {/* + New */}
            <div className="px-2 pt-2 pb-1">
              <button
                onClick={handleStartCreate}
                className={`flex items-center w-full px-2 py-1.5 cursor-pointer transition-colors cut-corners ${
                  mode === 'create'
                    ? 'bg-[var(--accent-secondary)] text-[var(--accent-secondary-fg)]'
                    : 'hover:bg-[var(--bg-hover)] text-[var(--text-primary)]'
                }`}
              >
                <span className={`w-5 h-5 rounded flex items-center justify-center mr-2 flex-shrink-0 ${
                  mode === 'create' ? 'bg-white/20' : 'bg-[var(--bg-hover)]'
                }`}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="12" y1="5" x2="12" y2="19" />
                    <line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                </span>
                <span className="flex-1 text-xs text-left">New variable</span>
              </button>
            </div>

            <div className="h-px bg-[var(--border-light)] my-1 mx-2" />

            {/* List */}
            <div className="overflow-y-auto flex-1 scrollbar-hide">
              {variables.length === 0 ? (
                <div className="px-4 py-8 text-center text-[var(--text-secondary)]">
                  <p className="text-xs">No variables yet</p>
                  <p className="text-xs mt-1 opacity-60">Create one to get started</p>
                </div>
              ) : (
                <div className="flex flex-col py-0.5">
                  {variables.map(v => {
                    const isSelected = selectedName === v.name && mode === 'view';
                    return (
                      <button
                        key={v.name}
                        onClick={() => handleSelectVariable(v.name)}
                        className={`flex items-center text-left px-3 py-2 cursor-pointer transition-colors cut-corners mx-2 ${
                          isSelected
                            ? 'bg-[var(--accent-secondary)] text-[var(--accent-secondary-fg)]'
                            : 'hover:bg-[var(--bg-hover)] text-[var(--text-primary)]'
                        }`}
                      >
                        <span className={`w-5 h-5 rounded flex items-center justify-center mr-2 flex-shrink-0 ${
                          isSelected ? 'bg-white/20 text-[var(--accent-fg)]' : 'bg-[var(--accent)] text-[var(--accent-fg)]'
                        }`}>
                          <VariableTypeIcon iconKey={resolveVariableIconKey({ pageVarType: v.type })} size={13} />
                        </span>
                        <div className="flex-1 min-w-0">
                          <div className="text-xs truncate">{v.name}</div>
                          <div className={`text-[10px] capitalize ${isSelected ? 'text-[var(--accent-fg)]/70' : 'text-[var(--text-secondary)] opacity-60'}`}>
                            {v.type}{v.queryParam ? ` · ?${v.queryParam}` : ''}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* ─── Right panel ──────────────────────────────────────── */}
          <div className="flex-1 flex flex-col">
            <div className="flex-1 p-6 overflow-y-auto space-y-5">
              {/* Name */}
              <Field label="Variable name" error={nameError}>
                <input
                  type="text"
                  value={draftName}
                  onChange={(e) => setDraftName(e.target.value)}
                  placeholder="e.g. opacity"
                  autoFocus={mode === 'create'}
                  className={`w-full h-[var(--control-height)] px-3 text-xs bg-[var(--grid-line)] cut-corners cut-border text-[var(--text-primary)] focus:outline-none transition-colors ${
                    nameError
                      ? 'border border-red-500 [--cut-border-color:#ef4444] focus:border-red-500 focus:[--cut-border-color:#ef4444]'
                      : 'border border-[var(--border-light)] [--cut-border-color:var(--border-light)] hover:border-[var(--control-border)] hover:[--cut-border-color:var(--control-border)] focus:border-[var(--border-focus)] focus:[--cut-border-color:var(--border-focus)]'
                  }`}
                />
              </Field>

              {/* Type */}
              <Field label="Type">
                <ToolSegmentedControl
                  value={draftType}
                  onChange={handleTypeChange}
                  options={TYPE_OPTIONS}
                  size="sm"
                />
              </Field>

              {/* Default value — control depends on type */}
              <Field label="Default value">
                <DefaultValueControl
                  type={draftType}
                  value={draftDefault}
                  onChange={setDraftDefault}
                />
              </Field>

              {/* Query param */}
              <Field
                label="URL query param (optional)"
                error={queryParamError}
                hint="When set, the variable initialises from ?param=value on page load."
              >
                <input
                  type="text"
                  value={draftQueryParam}
                  onChange={(e) => setDraftQueryParam(e.target.value)}
                  placeholder="e.g. tab"
                  className={`w-full h-[var(--control-height)] px-3 text-xs bg-[var(--grid-line)] cut-corners cut-border text-[var(--text-primary)] focus:outline-none transition-colors ${
                    queryParamError
                      ? 'border border-red-500 [--cut-border-color:#ef4444] focus:border-red-500 focus:[--cut-border-color:#ef4444]'
                      : 'border border-[var(--border-light)] [--cut-border-color:var(--border-light)] hover:border-[var(--control-border)] hover:[--cut-border-color:var(--control-border)] focus:border-[var(--border-focus)] focus:[--cut-border-color:var(--border-focus)]'
                  }`}
                />
              </Field>
            </div>

            {/* Footer actions */}
            <div className="border-t border-[var(--border-light)] p-4 flex items-center justify-between">
              <div>
                {mode === 'view' && selected && (
                  <button
                    onClick={handleRemove}
                    className="px-3 h-7 text-xs text-red-500 hover:text-red-400 transition-colors"
                  >
                    Remove variable
                  </button>
                )}
              </div>
              <div className="flex gap-2">
                {mode === 'create' && (
                  <>
                    <button
                      onClick={onClose}
                      className="px-4 h-[var(--control-height-sm)] text-xs bg-[var(--control-bg)] text-[var(--text-primary)] border border-[var(--border-light)] cut-corners cut-border [--cut-border-color:var(--border-light)] hover:bg-[var(--bg-hover)] transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleCreate}
                      disabled={!isValid}
                      className="px-4 h-7 text-xs bg-[var(--accent-secondary)] text-[var(--accent-secondary-fg)] cut-corners hover:brightness-110 transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:brightness-100"
                    >
                      Create variable
                    </button>
                  </>
                )}
                {mode === 'view' && (
                  <button
                    onClick={handleSave}
                    disabled={!isValid || !dirty}
                    className="px-4 h-7 text-xs bg-[var(--accent-secondary)] text-[var(--accent-secondary-fg)] cut-corners hover:brightness-110 transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:brightness-100"
                  >
                    Save changes
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}

// ─── Default-value control — adapts to variable type ─────────────────────────

interface DefaultValueControlProps {
  type: PageVariableType;
  value: string;
  onChange: (v: string) => void;
}

function DefaultValueControl({ type, value, onChange }: DefaultValueControlProps) {
  if (type === 'boolean') {
    return (
      <ToolSegmentedControl
        value={value === 'true' ? 'true' : 'false'}
        onChange={(v) => onChange(v)}
        options={[
          { value: 'true',  label: 'Yes' },
          { value: 'false', label: 'No'  },
        ]}
        size="sm"
      />
    );
  }
  if (type === 'color') {
    return <ColorInput value={value} onChange={onChange} />;
  }
  if (type === 'image') {
    return <ImagePickerInput value={value} onChange={onChange} />;
  }
  if (type === 'number') {
    // Slider for likely-opacity/percent values, plus a numeric input. Free-form
    // numbers (e.g. counter / pagination index) are still handled by the input;
    // the slider just covers the common 0–1 range.
    const num = parseFloat(value);
    const isOpacityish = !Number.isNaN(num) && num >= 0 && num <= 1;
    return (
      <div className="flex items-center gap-2 w-full">
        {isOpacityish && (
          <ToolSlider
            value={num}
            min={0}
            max={1}
            step={0.01}
            onChange={(n) => onChange(String(n))}
          />
        )}
        <ToolInput value={value} onChange={onChange} step={0.1} />
      </div>
    );
  }
  // text
  return <ToolInput value={value} onChange={onChange} text />;
}

// ─── Field wrapper ──────────────────────────────────────────────────────────

interface FieldProps {
  label: string;
  error?: string | null;
  hint?: string;
  children: React.ReactNode;
}

function Field({ label, error, hint, children }: FieldProps) {
  return (
    <div>
      <label className="block text-[var(--text-secondary)] text-xs mb-2">{label}</label>
      {children}
      {error && <p className="text-xs text-red-500 mt-1">{error}</p>}
      {!error && hint && <p className="text-[10px] text-[var(--text-secondary)] opacity-60 mt-1.5">{hint}</p>}
    </div>
  );
}
