// SortControl.tsx — Collection List "Sorting" (design-tool parity). Uses the shared
// EntryList (each sort rule = a row with field name + ×, plus an "Add…" row) and
// opens an "Order" ToolPopup with standard label+control rows (Field + Order).
// Order options are field-type-aware (A→Z text, Old→New date, Low→High number).
// CONTROLLED: reads `sort` from props, writes via `onChange`; the popup body is
// `children` (re-rendered fresh) so the active editor never goes stale.

import { useRef, useState } from 'react';
import EntryList from '../../controls/EntryList';
import ToolRow from '../../controls/ToolRow';
import ToolPopup from '../../ui/ToolPopup';
import { ToolSelect } from '../../controls';
import type { SortConfig, CollectionSchema, FieldDefinition } from '@/shared/types';
import { orderLabels, effectiveFieldType, fieldsForSortFilter, COLLECTION_VALUE_CLS } from './cms-filter-utils';
import CollectionRowIcon from './CollectionRowIcon';
import { trace } from '@/shared/debug-trace';

interface Props {
  schema: CollectionSchema | null;
  sort: SortConfig[];
  onChange: (sort: SortConfig[]) => void;
  /** Active per-viewport/variant override on this row → accent label + Reset Override. */
  overridden?: boolean;
  onResetOverride?: () => void;
}

export default function SortControl({ schema, sort, onChange, overridden, onResetOverride }: Props) {
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const btnRef = useRef<HTMLElement>(null);
  const fields = fieldsForSortFilter(schema);
  const fieldDef = (id: string): FieldDefinition | undefined => fields.find(f => f.id === id);
  const fieldName = (id: string): string => fieldDef(id)?.name ?? id;
  // A sort rule whose field is missing from the loaded schema (e.g. after a Source
  // change) is INACTIVE → shows "Inactive" + a "Select…" field picker (design-tool parity).
  const isInactive = (id: string): boolean => !!schema && !fields.some(f => f.id === id);

  const entries = sort.map((s, i) => ({ id: String(i), ...s }));

  const update = (idx: number, patch: Partial<SortConfig>) => {
    trace.action('sort-control:update', { idx, patch });
    onChange(sort.map((s, i) => (i === idx ? { ...s, ...patch } : s)));
  };
  const openEditor = (idx: number) => { setActiveIdx(idx); setOpen(true); };
  const add = () => {
    const first = fields[0];
    const next: SortConfig[] = [...sort, { field: first?.id ?? '_id', direction: 'asc' }];
    onChange(next);
    setActiveIdx(next.length - 1);
    setOpen(true);
  };

  const active = sort[activeIdx];

  return (
    <>
      <EntryList
        label="Sorting"
        property="collectionSort"
        entries={entries}
        rowClassName={`${COLLECTION_VALUE_CLS} !pr-2`}
        addLabel="Add…"
        overridden={overridden}
        onResetOverride={onResetOverride}
        onEdit={openEditor}
        onRemove={(idx) => onChange(sort.filter((_, i) => i !== idx))}
        onAdd={add}
        renderSwatch={() => ({ backgroundColor: 'var(--accent)' })}
        renderIcon={(e) => <CollectionRowIcon glyph="sort" active={e != null} />}
        renderLabel={(e) => (isInactive(e.field) ? 'Inactive' : fieldName(e.field))}
        addButtonRef={btnRef}
      />
      <ToolPopup isOpen={open} onClose={() => setOpen(false)} title="Order" anchorRef={btnRef} width={260}>
        {active && (() => {
          const inactive = isInactive(active.field);
          return (
          <div className="flex flex-col gap-2">
            <ToolRow label="Field">
              <ToolSelect
                value={inactive ? '' : active.field}
                onChange={(v) => { if (v) update(activeIdx, { field: v }); }}
                options={[...(inactive ? [{ value: '', label: 'Select…' }] : []), ...fields.map(f => ({ value: f.id, label: f.name }))]}
              />
            </ToolRow>
            {!inactive && (
              <ToolRow label="Order">
                <ToolSelect
                  value={active.direction}
                  onChange={(v) => update(activeIdx, { direction: v as 'asc' | 'desc' })}
                  options={orderLabels(effectiveFieldType(fieldDef(active.field), active.field))}
                />
              </ToolRow>
            )}
          </div>
          );
        })()}
      </ToolPopup>
    </>
  );
}
