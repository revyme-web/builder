// ObjectListControl.tsx — a repeating list of OBJECTS for code-component
// @controls (control type "objectList"). The panel row shows the item count
// and opens a ToolPopup with one sub-row per item (label / reorder / remove)
// plus an Add row; clicking a row expands its fields inline, each rendered by
// CodeComponentControlField from `item.controls`.
//
// The value is a real ARRAY prop — `items={[{ question, answer }, …]}` — which
// is the shape a component consumes with `.map()`, and the shape the reference builder's
// ControlType.Array of ControlType.Object imports onto. The other list
// control, `imageList`, is a flat pipe-joined string of urls; this one is for
// records with named fields.

import { useRef, useState } from 'react';
import type { ComponentControlDef } from '@/code/components/controls-parser';
import { ToolRow } from '../controls';
import ToolPopup from '../ui/ToolPopup';
import { ControlActionRow } from '../controls/ControlActionRow';
import { RemoveButton } from '../controls/RemoveButton';
import { CodeComponentControlField } from './ComponentPropsTool/CodeComponentControlField';
import { trace } from '@/shared/debug-trace';

type Item = Record<string, unknown>;

interface ObjectListControlProps {
  label: string;
  /** The item shape + optional `itemLabel`. */
  controlDef: ComponentControlDef;
  value: Item[];
  onChange: (value: Item[]) => void;
}

/** The field whose value names a row. The author's `itemLabel` wins; failing
 *  that the first text-ish field, so a list of questions reads as its
 *  questions rather than "Item 1". */
export function labelField(controlDef: ComponentControlDef): string | undefined {
  const fields = controlDef.item?.controls ?? {};
  if (controlDef.itemLabel && fields[controlDef.itemLabel]) return controlDef.itemLabel;
  return Object.keys(fields).find((k) => fields[k].type === 'text') ?? Object.keys(fields)[0];
}

/** One item with every field at its control's default — what Add appends. */
export function blankItem(controlDef: ComponentControlDef): Item {
  const out: Item = {};
  for (const [name, def] of Object.entries(controlDef.item?.controls ?? {})) {
    out[name] = def.default ?? (def.type === 'toggle' ? false : def.type === 'number' || def.type === 'slider' ? 0 : '');
  }
  return out;
}

/** A field's edited string back to the type its control writes, so a number
 *  field stays a number in the emitted array and the component's arithmetic
 *  keeps working. */
const coerceField = (def: ComponentControlDef, raw: string): unknown => {
  if (def.type === 'number' || def.type === 'slider') {
    const n = parseFloat(raw);
    return Number.isNaN(n) ? 0 : n;
  }
  if (def.type === 'toggle') return raw === 'true';
  return raw;
};

export default function ObjectListControl({ label, controlDef, value, onChange }: ObjectListControlProps) {
  const [open, setOpen] = useState(false);
  /** Which row is expanded for editing, or null when the list is collapsed. */
  const [editing, setEditing] = useState<number | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const items = Array.isArray(value) ? value : [];
  const fields = Object.entries(controlDef.item?.controls ?? {});
  const nameField = labelField(controlDef);

  const commit = (next: Item[]) => {
    trace.action('object-list:commit', { count: next.length });
    onChange(next);
  };

  const move = (idx: number, dir: -1 | 1) => {
    const to = idx + dir;
    if (to < 0 || to >= items.length) return;
    const next = [...items];
    const [item] = next.splice(idx, 1);
    next.splice(to, 0, item);
    // The expanded row travels with the item it belongs to, or the popup
    // would be editing whatever slid into that index.
    if (editing === idx) setEditing(to);
    else if (editing === to) setEditing(idx);
    commit(next);
  };

  const remove = (idx: number) => {
    if (editing !== null) setEditing(editing === idx ? null : editing > idx ? editing - 1 : editing);
    commit(items.filter((_, i) => i !== idx));
  };

  const setField = (idx: number, name: string, def: ComponentControlDef, raw: string) => {
    const next = items.map((item, i) => (i === idx ? { ...item, [name]: coerceField(def, raw) } : item));
    commit(next);
  };

  const rowLabel = (item: Item, idx: number): string => {
    const raw = nameField ? item[nameField] : undefined;
    const text = typeof raw === 'string' || typeof raw === 'number' ? String(raw) : '';
    return text.trim() || `Item ${idx + 1}`;
  };

  return (
    <ToolRow label={label}>
      <button
        ref={btnRef}
        onClick={() => setOpen((o) => !o)}
        className="w-full h-[var(--control-height-sm)] px-2 flex items-center gap-2 text-xs cut-corners cut-border hover:[--cut-border-color:var(--control-border-hover)] bg-[var(--control-bg)] border border-[var(--control-border)] [--cut-border-color:var(--control-border)] hover:border-[var(--control-border-hover)] text-[var(--text-primary)] transition-colors min-w-0 overflow-hidden"
      >
        <span className="flex-1 text-left text-[var(--text-tertiary)] truncate">
          {items.length === 0 ? 'No items' : `${items.length} item${items.length === 1 ? '' : 's'}`}
        </span>
      </button>

      <ToolPopup isOpen={open} onClose={() => setOpen(false)} title={label} anchorRef={btnRef}>
        {items.map((item, idx) => (
          <div key={idx} className="flex flex-col gap-1 min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              <button
                onClick={() => setEditing((e) => (e === idx ? null : idx))}
                className="flex-1 text-left text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] truncate transition-colors"
                title="Edit item"
              >
                {rowLabel(item, idx)}
              </button>
              <button
                onClick={() => move(idx, -1)}
                disabled={idx === 0}
                className="w-5 h-5 flex items-center justify-center rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] disabled:opacity-30"
                title="Move up"
              >↑</button>
              <button
                onClick={() => move(idx, 1)}
                disabled={idx === items.length - 1}
                className="w-5 h-5 flex items-center justify-center rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] disabled:opacity-30"
                title="Move down"
              >↓</button>
              <RemoveButton onClick={() => remove(idx)} />
            </div>
            {editing === idx && (
              <div className="flex flex-col gap-1 pl-2 pb-1">
                {fields.map(([name, def]) => (
                  <ToolRow key={name} label={def.label || name}>
                    <CodeComponentControlField
                      controlDef={def}
                      value={item[name] === undefined || item[name] === null ? '' : String(item[name])}
                      onChange={(v) => setField(idx, name, def, v)}
                    />
                  </ToolRow>
                ))}
              </div>
            )}
          </div>
        ))}
        <ControlActionRow
          onClick={() => {
            commit([...items, blankItem(controlDef)]);
            setEditing(items.length);
          }}
          center
        >
          + Add item
        </ControlActionRow>
      </ToolPopup>
    </ToolRow>
  );
}
