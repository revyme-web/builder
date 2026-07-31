// FilterControl.tsx — Collection List "Filters" row + popup (design-tool parity).
// The "Filters" row shows a summary and opens a ToolPopup: Match All/Any + filter
// ROWS (icon + summary + ×) + an "Add…" row that re-opens the field picker.
// Clicking a filter row PUSHES a "Filter" panel (ToolPopup path navigation — same
// slide-back chevron as everywhere else, NOT a separate modal) with Field /
// Condition / Value. CONTROLLED: reads `filterGroup` from props, writes `onChange`.
// The pushed editor reads live state via a ref so multi-edits never go stale.

import { useEffect, useRef, useState } from 'react';
import { useAtomValue } from 'jotai';
import { ControlLabel, ControlActionRow, RemoveButton, ToolSelect, ToolInput, ToolSegmentedControl } from '../../controls';
import ToolRow from '../../controls/ToolRow';
import ToolPopup, { useToolPopup } from '../../ui/ToolPopup';
import { collectionDataAtom, collectionSchemasAtom } from '@/code/stores/cms-store';
import { cmsItemLabel } from '@/code/project/cms-ops';
import type { FilterConfig, FilterGroup, CollectionSchema, FieldDefinition, CollectionItem } from '@/shared/types';
import { operatorsForFieldType, operatorTakesNoValue, filterSummary, fieldsForSortFilter, COLLECTION_VALUE_CLS } from './cms-filter-utils';
import CollectionRowIcon from './CollectionRowIcon';
import PageVariableChip from '../../controls/PageVariableChip';
import FilterFieldPicker from './FilterFieldPicker';
import { trace } from '@/shared/debug-trace';

interface Props {
  schema: CollectionSchema | null;
  filterGroup: FilterGroup | null;
  onChange: (fg: FilterGroup | null) => void;
  /** Active per-viewport/variant override on this row → accent label + Reset Override. */
  overridden?: boolean;
  onResetOverride?: () => void;
  /** Enable the field-picker's "Dynamic → Search Field" option (page base context
   *  only — search fields bind to a PAGE variable, so not on replicas/variants). */
  allowDynamic?: boolean;
  /** Create a Search Field (bound input + page variable) for `fieldId`, then add
   *  the matching dynamic filter. Owns the var name (needs code access), so the
   *  whole dynamic add lives in the parent. */
  onAddSearchField?: (fieldId: string) => void;
}

const mkGroup = (filters: FilterConfig[], combinator: 'and' | 'or'): FilterGroup | null =>
  filters.length > 0 ? { combinator, filters } : null;

// Live data the pushed Filter editor reads through (kept fresh each render so the
// imperatively-pushed panel never closes over a stale `filters`/handler).
interface EditorData {
  filters: FilterConfig[];
  fields: FieldDefinition[];
  fieldDef: (id: string) => FieldDefinition | undefined;
  fieldType: (id: string) => FieldDefinition['type'] | undefined;
  update: (idx: number, patch: Partial<FilterConfig>) => void;
  changeField: (idx: number, fieldId: string) => void;
  onAddPicker: () => void;
  onRemove: (idx: number) => void;
  /** Items of a referenced collection → {value:_slug, label} for a reference field's value select. */
  getRefItems: (slug: string | undefined) => { value: string; label: string }[];
  /** A filter whose field no longer exists in the current schema (e.g. after a
   *  Source change) is INACTIVE — shown as a placeholder needing a field re-select. */
  isInactive: (fieldId: string) => boolean;
}

// Native date input styled to match ToolInput (dark color-scheme picker).
const DATE_INPUT_CLASS = 'w-full h-8 px-2 text-xs bg-[var(--grid-line)] border border-[var(--control-border)] hover:border-[var(--control-border-hover)] focus:border-[var(--border-focus)] text-[var(--text-primary)] rounded-[var(--radius-lg)] focus:outline-none transition-colors [color-scheme:dark]';

// ─── Popup body (rendered INSIDE the ToolPopup → can call useToolPopup) ───────
function FiltersPopupBody({
  filters, combinator, fields, fieldName, onCombinator, dataRef, addRowRef, autoEditIdx, onAutoEditConsumed,
}: {
  filters: FilterConfig[];
  combinator: 'and' | 'or';
  fields: FieldDefinition[];
  fieldName: (id: string) => string;
  onCombinator: (c: 'and' | 'or') => void;
  dataRef: React.MutableRefObject<EditorData>;
  addRowRef: React.RefObject<HTMLDivElement | null>;
  autoEditIdx: number | null;
  onAutoEditConsumed: () => void;
}) {
  const { pushPanel } = useToolPopup();

  // Type-aware value widget — the input MATCHES the field type (text→text,
  // date→date picker, number→numeric, boolean→toggle, enum/reference→select).
  const valueWidget = (f: FilterConfig, idx: number) => {
    const d = dataRef.current;
    // DYNAMIC value (Search Field / Date Picker): the predicate reads a PAGE
    // variable, so the Value is the bound variable — not an editable literal.
    if ((f.valueSource === 'searchField' || f.valueSource === 'dateField') && f.valueVar) {
      return <PageVariableChip name={f.valueVar} />;
    }
    const ftype = d.fieldType(f.field);
    if (ftype === 'boolean') {
      return <ToolSegmentedControl value={String(f.value === true || f.value === 'true')} onChange={(v) => d.update(idx, { value: v === 'true' })} options={[{ value: 'true', label: 'True' }, { value: 'false', label: 'False' }]} size="sm" />;
    }
    if (ftype === 'enum') {
      return <ToolSelect value={String(f.value ?? '')} onChange={(v) => d.update(idx, { value: v })} options={(d.fieldDef(f.field)?.options ?? []).map(o => ({ value: o, label: o }))} />;
    }
    if (ftype === 'reference' || ftype === 'multi-reference') {
      const items = d.getRefItems(d.fieldDef(f.field)?.referenceCollection);
      return <ToolSelect value={String(f.value ?? '')} onChange={(v) => d.update(idx, { value: v })} options={[{ value: '', label: 'Select…' }, ...items]} />;
    }
    if (f.operator === 'between') {
      const dateRange = ftype === 'date';
      const mk = (v: string, on: (x: string) => void) => dateRange
        ? <input type="date" value={v} onChange={(e) => on(e.target.value)} className={`${DATE_INPUT_CLASS} flex-1`} />
        : <ToolInput text value={v} onChange={on} className="flex-1" />;
      return (
        <div className="flex items-center gap-1.5 w-full">
          {mk(String(f.value?.[0] ?? ''), (v) => d.update(idx, { value: [v, f.value?.[1] ?? ''] }))}
          <span className="text-xs text-[var(--text-disabled)]">–</span>
          {mk(String(f.value?.[1] ?? ''), (v) => d.update(idx, { value: [f.value?.[0] ?? '', v] }))}
        </div>
      );
    }
    if (ftype === 'date') {
      return <input type="date" value={String(f.value ?? '')} onChange={(e) => d.update(idx, { value: e.target.value })} className={DATE_INPUT_CLASS} />;
    }
    if (ftype === 'number') {
      return <ToolInput value={String(f.value ?? '')} onChange={(v) => d.update(idx, { value: v })} step={1} />;
    }
    return <ToolInput text value={String(f.value ?? '')} onChange={(v) => d.update(idx, { value: v })} />;
  };

  // Push the Filter editor panel. The render fn reads `dataRef.current` on every
  // ToolPopup re-render → always reflects the latest filter + uses the latest
  // handlers (no stale closure across successive edits).
  const openEditor = (idx: number) => {
    trace.action('filter-control:edit', { idx });
    pushPanel('Filter', () => {
      const d = dataRef.current;
      const f = d.filters[idx];
      if (!f) return null;
      // Inactive = the field is missing from the current schema (post Source change).
      // Show ONLY a "Select…" field picker (no Condition/Value until re-selected).
      const inactive = d.isInactive(f.field);
      return (
        <div className="flex flex-col gap-2">
          <ToolRow label="Field">
            <ToolSelect
              value={inactive ? '' : f.field}
              onChange={(v) => { if (v) d.changeField(idx, v); }}
              options={[...(inactive ? [{ value: '', label: 'Select…' }] : []), ...d.fields.map(fl => ({ value: fl.id, label: fl.name }))]}
            />
          </ToolRow>
          {!inactive && (
            <ToolRow label="Condition">
              <ToolSelect value={f.operator} onChange={(v) => d.update(idx, { operator: v as FilterConfig['operator'], value: v === 'between' ? ['', ''] : f.value })} options={operatorsForFieldType(d.fieldType(f.field))} />
            </ToolRow>
          )}
          {!inactive && !operatorTakesNoValue(f.operator) && (
            <ToolRow label="Value">{valueWidget(f, idx)}</ToolRow>
          )}
        </div>
      );
    });
  };

  // Picking Static from the field-picker slides STRAIGHT into the editor for the
  // new filter (design-tool parity) — the parent sets autoEditIdx, we push here (this
  // component is inside the ToolPopup, so useToolPopup is available).
  useEffect(() => {
    if (autoEditIdx == null) return;
    openEditor(autoEditIdx);
    onAutoEditConsumed();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoEditIdx]);

  return (
    <div className="flex flex-col gap-2">
      <ToolRow label="Match">
        <ToolSegmentedControl
          value={combinator}
          onChange={(v) => onCombinator(v as 'and' | 'or')}
          options={[{ value: 'and', label: 'All' }, { value: 'or', label: 'Any' }]}
          size="sm"
        />
      </ToolRow>

      {/* Filter ROWS (icon + summary + ×, click → pushed editor) + an Add row.
          Custom label/value split (NOT ToolRow) because ToolRow's value div has
          no `min-w-0` — long filter summaries would grow it past the Match row's
          width. `min-w-0` on the value column keeps it aligned + truncating. */}
      <div className="flex items-start justify-between w-full">
        <div className="w-3/4 pl-[18px] -ml-[18px] mr-[2px] pt-1.5">
          <span className="text-xs font-bold text-[var(--text-secondary)] select-none">Filters</span>
        </div>
        <div className="flex flex-col gap-1.5 w-full min-w-0">
          {filters.map((f, idx) => {
            const inactive = dataRef.current.isInactive(f.field);
            return (
            <div key={idx} className="w-full">
              <ControlActionRow onClick={() => openEditor(idx)} className="min-w-0 !pr-2">
                <CollectionRowIcon glyph="filter" active />
                <span className={`flex-1 min-w-0 truncate text-left text-xs ${inactive ? 'text-[var(--text-secondary)]' : 'text-[var(--text-primary)]'}`}>{inactive ? 'Inactive' : filterSummary(f, fieldName(f.field))}</span>
                <RemoveButton onClick={() => dataRef.current.onRemove(idx)} />
              </ControlActionRow>
            </div>
            );
          })}
          <div ref={addRowRef} className="w-full">
            <ControlActionRow onClick={() => dataRef.current.onAddPicker()} className="min-w-0">
              <CollectionRowIcon glyph="filter" active={false} />
              <span className="flex-1 min-w-0 text-xs text-[var(--text-secondary)] text-left truncate">Add…</span>
            </ControlActionRow>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function FilterControl({ schema, filterGroup, onChange, overridden, onResetOverride, allowDynamic, onAddSearchField }: Props) {
  const [open, setOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerFrom, setPickerFrom] = useState<'row' | 'add'>('row');
  const [autoEditIdx, setAutoEditIdx] = useState<number | null>(null);
  const collectionData = useAtomValue(collectionDataAtom);
  const collectionSchemas = useAtomValue(collectionSchemasAtom);
  const rowRef = useRef<HTMLDivElement>(null);
  const addRowRef = useRef<HTMLDivElement>(null);
  const filters = filterGroup?.filters ?? [];
  const combinator = filterGroup?.combinator ?? 'and';
  const fields = fieldsForSortFilter(schema);
  const fieldDef = (id: string): FieldDefinition | undefined => fields.find(f => f.id === id);
  const fieldType = (id: string) => fieldDef(id)?.type;
  const fieldName = (id: string): string => fieldDef(id)?.name ?? id;

  // A filter whose field isn't in the loaded schema is INACTIVE (e.g. a per-replica
  // filter on `name` after the Source changed to a collection with no `name` field).
  // Guard on `schema` so a still-loading schema doesn't false-flag everything.
  const isInactive = (fieldId: string): boolean => !!schema && !fields.some(fl => fl.id === fieldId);
  const anyInactive = filters.some(f => isInactive(f.field));

  // Don't preview a single filter's content on the panel row — a list can hold
  // many filters, so show a count (or "Add…" when empty). A missing field shows
  // "Inactive" (design-tool parity) so the user knows to re-select it. The set lives in the popup.
  const summary = filters.length === 0 ? 'Add…'
    : anyInactive ? 'Inactive'
    : `${filters.length} Filter${filters.length === 1 ? '' : 's'}`;

  const update = (idx: number, patch: Partial<FilterConfig>) => {
    trace.action('filter-control:update', { idx, patch });
    onChange(mkGroup(filters.map((f, i) => (i === idx ? { ...f, ...patch } : f)), combinator));
  };
  const remove = (idx: number) => onChange(mkGroup(filters.filter((_, i) => i !== idx), combinator));
  // Add a STATIC filter for the field chosen in the field-picker (default operator
  // for its type) → it appears as a row in the Filters popup (click to refine).
  const addForField = (fieldId: string) => {
    const op = operatorsForFieldType(fieldType(fieldId))[0].value;
    const newIdx = filters.length; // index of the about-to-be-added filter
    onChange(mkGroup([...filters, { field: fieldId, operator: op, value: '' }], combinator));
    setOpen(true);
    setAutoEditIdx(newIdx); // slide straight into the editor for the new filter
  };
  // Field change resets operator to a valid one for the new type.
  const changeField = (idx: number, fieldId: string) => {
    const ops = operatorsForFieldType(fieldType(fieldId));
    const cur = filters[idx].operator;
    update(idx, { field: fieldId, operator: ops.some(o => o.value === cur) ? cur : ops[0].value, value: '' });
  };
  const openPicker = () => { setPickerFrom('add'); setPickerOpen(true); };
  // Options for a reference field's value select = the referenced collection's
  // items. The value is the item `_id` (what `item.<refField>` holds, so the
  // generated `===` predicate matches) and the label is its human title — same
  // contract as the CMS panel's ReferencePicker. Empty when no data/schema yet.
  const getRefItems = (slug: string | undefined): { value: string; label: string }[] => {
    if (!slug) return [];
    const items: CollectionItem[] = collectionData.get(slug) ?? [];
    const refSchema = collectionSchemas.get(slug) ?? null;
    return items.map((it) => ({
      value: it._id,
      label: refSchema ? cmsItemLabel(it, refSchema) : (it._slug || it._id),
    }));
  };

  // Keep the editor's live data fresh every render (the pushed panel reads this).
  const dataRef = useRef<EditorData>(null as unknown as EditorData);
  dataRef.current = { filters, fields, fieldDef, fieldType, update, changeField, onAddPicker: openPicker, onRemove: remove, getRefItems, isInactive };

  return (
    <div className="flex items-center justify-between w-full" ref={rowRef}>
      <ControlLabel label="Filters" property="collectionFilters" plain overridden={overridden} onResetOverride={onResetOverride} />
      <ControlActionRow onClick={() => { if (filters.length === 0) { setPickerFrom('row'); setPickerOpen(true); } else setOpen(true); }} className={`${COLLECTION_VALUE_CLS}${filters.length > 0 ? ' !pr-2' : ''}`}>
        <CollectionRowIcon glyph="filter" active={filters.length > 0} />
        <span className={`flex-1 min-w-0 text-xs truncate text-left ${filters.length > 0 ? 'text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'}`}>{summary}</span>
        {filters.length > 0 && <RemoveButton onClick={() => onChange(null)} />}
      </ControlActionRow>

      {/* Field picker (standard): search all fields → Static / Dynamic.
          Dynamic (Search Field) is offered only in the page base context. */}
      <FilterFieldPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        fields={fields}
        anchorRef={pickerFrom === 'add' ? addRowRef : rowRef}
        onPickStatic={addForField}
        onPickDynamic={allowDynamic && onAddSearchField
          ? (fieldId) => { trace.action('filter-control:add-search-field', { field: fieldId }); onAddSearchField(fieldId); }
          : undefined}
      />

      <ToolPopup isOpen={open} onClose={() => setOpen(false)} title="Filters" anchorRef={rowRef} width={280}>
        <FiltersPopupBody
          filters={filters}
          combinator={combinator}
          fields={fields}
          fieldName={fieldName}
          onCombinator={(c) => onChange(mkGroup(filters, c))}
          dataRef={dataRef}
          addRowRef={addRowRef}
          autoEditIdx={autoEditIdx}
          onAutoEditConsumed={() => setAutoEditIdx(null)}
        />
      </ToolPopup>
    </div>
  );
}
