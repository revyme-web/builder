// FormStateTool — Properties-panel "Form State" section (design-tool parity).
//
// Shown when a component INSTANCE with variants is selected inside a <form>.
// Maps the form's lifecycle states (Loading / Success / Error / Disabled) to the
// instance's own variants. While the form submits, the instance switches to the
// mapped variant: the form owns a `formState<Id>` var (form-gen onSubmit drives
// it idle→loading→success|error→idle) and the instance binds
// `initialVariant={formState<Id> === 'loading' ? <variant> : …}` — all via the
// `setFormStateMapping` mutation (form-state-gen.ts).

import { useMemo, useState, useRef, useEffect } from 'react';
import { useAtomValue } from 'jotai';
import { codeAtom, selectedNodeAtom } from '@/code/stores/store';
import { useNode, useNodesComputed } from '@/code/stores/node-family';
import { ToolSection, ToolRow, ToolSelect, ControlActionRow, RemoveButton } from '../controls';
import { queueMutation, flushNow } from '@/code/mutation/mutation-queue';
import { projectFS } from '@/code/project/project-fs';
import { parseVariantConfig } from '@/code/variants/variant-config';
import {
  parseFormStateMapping,
  formStateVar,
  FORM_STATES,
  type FormState,
  type FormStateMapping,
} from '@/code/generation/form-state-gen';
import { trace } from '@/shared/debug-trace';

const STATE_LABEL: Record<FormState, string> = {
  loading: 'Loading',
  success: 'Success',
  error: 'Error',
  disabled: 'Disabled',
};

const ADD_ITEM =
  'group flex items-center gap-2 mx-1.5 px-2.5 py-1.5 rounded w-[calc(100%-12px)] text-left cursor-pointer bg-transparent hover:!bg-[var(--accent)] border-none whitespace-nowrap';
const ADD_ITEM_LABEL = 'text-xs font-medium text-[var(--text-primary)] group-hover:text-white';

/** The "+" header action — a native floating dropdown of not-yet-mapped states. */
function AddStateMenu({ addable, onAdd }: { addable: FormState[]; onAdd: (s: FormState) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  if (addable.length === 0) return null;
  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center justify-center w-5 h-5 rounded text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--grid-line)]"
        aria-label="Add form state"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M12 5v14 M5 12h14" />
        </svg>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-50" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-1 bg-[var(--dropdown-bg)] shadow-md rounded-[var(--radius-md)] py-1.5 z-[51] w-max border border-[var(--border-light)]">
            {addable.map((s) => (
              <button key={s} className={ADD_ITEM} onClick={() => { setOpen(false); onAdd(s); }}>
                <span className={ADD_ITEM_LABEL}>{STATE_LABEL[s]}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export default function FormStateTool() {
  const code = useAtomValue(codeAtom);
  const selectedId = useAtomValue(selectedNodeAtom);

  const node = useNode(selectedId);

  // The enclosing <form>'s id (nearest form ancestor), or null. Skipped for a
  // canvas-node form: it's module-scope JSX with no component fn to hold the
  // lifecycle useState, so form-state mapping doesn't apply there.
  const formId = useNodesComputed((nodes) => {
    const n = selectedId ? nodes.get(selectedId) : undefined;
    if (!n) return null;
    let cur = n.parentId ? nodes.get(n.parentId) : undefined;
    for (let d = 0; cur && d < 50; d++) {
      if (cur.type === 'form') return cur.isCanvasNode ? null : cur.id;
      if (cur.isCanvasNode) return null;
      cur = cur.parentId ? nodes.get(cur.parentId) : undefined;
    }
    return null;
  }, [selectedId]);

  // The instance master's variants (the dropdown options).
  const variants = useMemo(() => {
    const cf = node?.componentFile;
    if (!cf) return [] as { name: string; label: string }[];
    const master = projectFS.readFile(cf);
    if (!master) return [];
    return parseVariantConfig(master).map((v) => ({ name: v.name, label: v.label || v.name }));
  }, [node]);

  const mapping: FormStateMapping = useMemo(
    () => (selectedId && code ? parseFormStateMapping(code, selectedId) : {}),
    [selectedId, code],
  );

  // Only for a component instance inside a form that actually HAS variants to map.
  if (!selectedId || !node || !formId || variants.length <= 1) return null;

  const stateVar = formStateVar(formId);
  const variantOptions = variants.map((v) => ({ value: v.name, label: v.label }));
  const activeStates = FORM_STATES.filter((s) => mapping[s]);
  const addable = FORM_STATES.filter((s) => !mapping[s]);

  const write = (next: FormStateMapping) => {
    queueMutation({ type: 'setFormStateMapping', nodeId: selectedId, stateVar, mapping: next });
    flushNow();
    trace.action('form-state-tool:write', { nodeId: selectedId, states: Object.keys(next) });
  };
  const setVariantFor = (s: FormState, variant: string) => write({ ...mapping, [s]: variant });
  const removeState = (s: FormState) => { const n = { ...mapping }; delete n[s]; write(n); };
  const addState = (s: FormState) => {
    // Default to a same-named variant, else the first non-primary variant.
    const match = variants.find((v) => v.name === s);
    const fallback = variants.find((v) => v.name !== 'default');
    write({ ...mapping, [s]: (match ?? fallback ?? variants[0]).name });
  };

  return (
    <ToolSection title="Form State" action={<AddStateMenu addable={addable} onAdd={addState} />}>
      {activeStates.length === 0 ? (
        <ControlActionRow onClick={() => addable[0] && addState(addable[0])} className="!pr-2">
          <span className="flex-1 text-left text-[var(--text-secondary)]">Add…</span>
        </ControlActionRow>
      ) : (
        activeStates.map((s) => (
          <ToolRow key={s} label={STATE_LABEL[s]}>
            <div className="flex items-center gap-1 w-full">
              <ToolSelect value={mapping[s]!} onChange={(v) => setVariantFor(s, v)} options={variantOptions} />
              <RemoveButton onClick={() => removeState(s)} />
            </div>
          </ToolRow>
        ))
      )}
    </ToolSection>
  );
}
