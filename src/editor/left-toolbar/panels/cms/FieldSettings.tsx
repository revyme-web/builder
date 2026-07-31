// FieldSettings.tsx — Type-aware config panel for a CMS schema field.
// Mirrors the reference's field-settings popover: each field type exposes its
// own config rows — a Color field edits a default color, a Number field
// has min/max/step, a Reference field picks a target collection, etc.
// Rendered in the CMS editor pane when the Fields tab has a field selected.

import { useState, useRef, useCallback, useEffect } from 'react';
import type { FieldDefinition, CollectionSchema, CollectionItem } from '@/shared/types';
import { SettingsGroup, SettingsRow, ROW_INPUT_CLS, RowSelect, Toggle } from '@/editor/overlays/settings-shared';
import { FIELD_TYPES, cmsItemLabel } from '@/code/project/cms-ops';
import FieldControl from './FieldControl';
import { trace } from '@/shared/debug-trace';

// ─── Type groupings ──────────────────────────────────────────────────────────

// Types that always carry a value — "Required" is meaningless for them.
const ALWAYS_HAS_VALUE = new Set<FieldDefinition['type']>(['boolean', 'color', 'number', 'enum']);
// Types whose default value FieldControl can edit inline.
const DEFAULTABLE = new Set<FieldDefinition['type']>([
  'text', 'textarea', 'number', 'boolean', 'date', 'url', 'link', 'color', 'enum', 'slug', 'image', 'tags',
]);
// Text-like types: support a max length + localization.
const TEXTY = new Set<FieldDefinition['type']>(['text', 'textarea', 'richtext']);

// ─── Props ───────────────────────────────────────────────────────────────────

interface FieldSettingsProps {
  field: FieldDefinition;
  /** Every collection in the project — feeds the Reference target picker. */
  collections: CollectionSchema[];
  /** All collection data — feeds the Reference default-value picker. */
  collectionData: Map<string, CollectionItem[]>;
  onChange: (patch: Partial<FieldDefinition>) => void;
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function FieldSettings({ field, collections, collectionData, onChange }: FieldSettingsProps) {
  trace.fn('FieldSettings.render', { fieldId: field.id, type: field.type });

  // Local draft — text inputs commit on blur, toggles/selects instantly.
  // The parent re-keys this component on the field's full content, so this
  // initializer re-runs fresh whenever the field changes — including when
  // the AI agent edits the field the user is currently viewing.
  const [draft, setDraft] = useState<FieldDefinition>(field);

  // Instant commit (toggles, selects, type).
  const commit = useCallback((patch: Partial<FieldDefinition>) => {
    setDraft(d => ({ ...d, ...patch }));
    onChange(patch);
  }, [onChange]);

  // Draft-only update — paired with commitKey on blur.
  const setLocal = useCallback((patch: Partial<FieldDefinition>) => {
    setDraft(d => ({ ...d, ...patch }));
  }, []);

  // Commit one draft key on blur, only if it diverged from the saved field.
  const commitKey = useCallback((key: keyof FieldDefinition) => {
    if (draft[key] !== field[key]) {
      onChange({ [key]: draft[key] } as Partial<FieldDefinition>);
    }
  }, [draft, field, onChange]);

  // Default-value commits are debounced — a FieldControl text input fires
  // onChange per keystroke and each commit re-writes the schema file.
  const defaultTimer = useRef<number | undefined>(undefined);
  const handleDefaultChange = useCallback((v: any) => {
    setDraft(d => ({ ...d, defaultValue: v }));
    window.clearTimeout(defaultTimer.current);
    defaultTimer.current = window.setTimeout(() => onChange({ defaultValue: v }), 300);
  }, [onChange]);
  useEffect(() => () => window.clearTimeout(defaultTimer.current), []);

  // Changing the type invalidates the stored default (a color hex is not a
  // valid number, etc.) — clear it so the new control starts blank.
  const handleTypeChange = useCallback((v: string) => {
    trace.action('field-settings:type-change', { fieldId: field.id, type: v });
    commit({ type: v as FieldDefinition['type'], defaultValue: undefined });
  }, [commit, field.id]);

  const t = draft.type;
  const showRequired = !ALWAYS_HAS_VALUE.has(t);
  const refItems = draft.referenceCollection ? collectionData.get(draft.referenceCollection) ?? [] : [];
  const refSchema = collections.find(c => c.slug === draft.referenceCollection) ?? null;

  // The default-value row — reused by the generic, number and enum blocks.
  const defaultRow = (
    <SettingsRow label="Default" align={t === 'textarea' || t === 'image' ? 'top' : 'center'}>
      <FieldControl field={draft} value={draft.defaultValue} onChange={handleDefaultChange} />
    </SettingsRow>
  );

  return (
    <div className="pb-6">
      {/* The `action` is an invisible 30px spacer: the Items editor's
          "Content" header carries Save/Cancel buttons, so matching the
          height keeps both section titles on the same baseline. */}
      <SettingsGroup title="Field" action={<div aria-hidden className="h-[30px]" />}>
        {/* Name */}
        <SettingsRow label="Name" htmlFor="cms-field-name">
          <input
            id="cms-field-name"
            type="text"
            value={draft.name}
            onChange={(e) => setLocal({ name: e.target.value })}
            onBlur={() => commitKey('name')}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
            className={ROW_INPUT_CLS}
            placeholder="Field name"
          />
        </SettingsRow>

        {/* Description */}
        <SettingsRow label="Description" htmlFor="cms-field-desc" align="top">
          <textarea
            id="cms-field-desc"
            value={draft.description ?? ''}
            onChange={(e) => setLocal({ description: e.target.value })}
            onBlur={() => commitKey('description')}
            rows={2}
            className={`${ROW_INPUT_CLS} resize-y`}
            placeholder="Optional help text"
          />
        </SettingsRow>

        {/* Type */}
        <SettingsRow label="Type" htmlFor="cms-field-type">
          <RowSelect
            id="cms-field-type"
            value={t}
            options={FIELD_TYPES.map(ft => ({ value: ft.value, label: ft.label }))}
            onChange={handleTypeChange}
          />
        </SettingsRow>

        {/* Required — hidden for types that always carry a value. */}
        {showRequired && (
          <SettingsRow label="Required">
            <Toggle value={!!draft.required} onChange={(v) => commit({ required: v })} />
          </SettingsRow>
        )}

        {/* ── Generic default (color / boolean / date / link / image / …) ── */}
        {DEFAULTABLE.has(t) && t !== 'enum' && t !== 'number' && defaultRow}

        {/* ── Number: default + min / max / step ──────────────────────────── */}
        {t === 'number' && (
          <>
            {defaultRow}
            <NumRow label="Min" value={draft.min} onCommit={(n) => commit({ min: n })} />
            <NumRow label="Max" value={draft.max} onCommit={(n) => commit({ max: n })} />
            <NumRow label="Step" value={draft.step} onCommit={(n) => commit({ step: n })} />
          </>
        )}

        {/* ── Enum: option list + default ─────────────────────────────────── */}
        {t === 'enum' && (
          <>
            <SettingsRow label="Options" align="top">
              <OptionsEditor options={draft.options ?? []} onChange={(opts) => commit({ options: opts })} />
            </SettingsRow>
            {defaultRow}
          </>
        )}

        {/* ── Text-like: max length + localization ────────────────────────── */}
        {TEXTY.has(t) && (
          <>
            <NumRow label="Max Length" value={draft.maxLength} onCommit={(n) => commit({ maxLength: n })} />
            <SettingsRow label="Localization">
              <Toggle value={!!draft.translatable} onChange={(v) => commit({ translatable: v })} />
            </SettingsRow>
          </>
        )}

        {/* ── Reference / Multi-reference: target collection ──────────────── */}
        {(t === 'reference' || t === 'multi-reference') && (
          <SettingsRow label="Collection">
            <RowSelect
              value={draft.referenceCollection ?? ''}
              options={collections.map(c => ({ value: c.slug, label: c.name }))}
              onChange={(v) => commit({ referenceCollection: v, defaultValue: undefined })}
              placeholder="Select collection…"
            />
          </SettingsRow>
        )}

        {/* Single reference — default item from the target collection. */}
        {t === 'reference' && draft.referenceCollection && refSchema && (
          <SettingsRow label="Default">
            <RowSelect
              value={draft.defaultValue ?? ''}
              options={refItems.map(it => ({ value: it._id, label: cmsItemLabel(it, refSchema) }))}
              onChange={(v) => commit({ defaultValue: v })}
              placeholder="No default"
            />
          </SettingsRow>
        )}

        {/* Multi-reference — count limits. */}
        {t === 'multi-reference' && (
          <>
            <NumRow label="Min" value={draft.min} onCommit={(n) => commit({ min: n })} />
            <NumRow label="Max" value={draft.max} onCommit={(n) => commit({ max: n })} />
          </>
        )}
      </SettingsGroup>
    </div>
  );
}

// ─── Number row — local draft, commits on blur ───────────────────────────────

function NumRow({ label, value, onCommit }: {
  label: string;
  value: number | undefined;
  onCommit: (n: number | undefined) => void;
}) {
  const [text, setText] = useState(value != null ? String(value) : '');

  const commit = () => {
    const trimmed = text.trim();
    if (trimmed === '') { onCommit(undefined); return; }
    const n = Number(trimmed);
    onCommit(Number.isNaN(n) ? undefined : n);
  };

  return (
    <SettingsRow label={label}>
      <input
        type="number"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        className={ROW_INPUT_CLS}
        placeholder="—"
        style={{ colorScheme: 'dark' }}
      />
    </SettingsRow>
  );
}

// ─── Enum option list editor ─────────────────────────────────────────────────

function OptionsEditor({ options, onChange }: {
  options: string[];
  onChange: (opts: string[]) => void;
}) {
  // Local draft so an intermediate empty option isn't dropped mid-typing.
  const [items, setItems] = useState<string[]>(options.length ? options : ['']);

  // Commit the cleaned list (trim, drop blanks) up to the schema.
  const commit = (next: string[]) => {
    trace.action('field-settings:options-commit', { count: next.length });
    onChange(next.map(s => s.trim()).filter(Boolean));
  };

  return (
    <div className="flex flex-col gap-1.5 w-full">
      {items.map((opt, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <input
            type="text"
            value={opt}
            onChange={(e) => setItems(items.map((o, j) => (j === i ? e.target.value : o)))}
            onBlur={() => commit(items)}
            placeholder={`Option ${i + 1}`}
            className="flex-1 h-7 px-2 text-xs bg-[var(--control-bg)] border border-[var(--control-border)] rounded-md text-[var(--text-primary)] placeholder:text-[var(--text-disabled)] focus:outline-none focus:border-[var(--accent)]"
          />
          <button
            onClick={() => {
              const next = items.filter((_, j) => j !== i);
              setItems(next.length ? next : ['']);
              commit(next);
            }}
            className="w-6 h-6 shrink-0 flex items-center justify-center text-[var(--text-disabled)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] rounded transition-colors cursor-pointer"
            title="Remove option"
          >
            &times;
          </button>
        </div>
      ))}
      <button
        onClick={() => setItems([...items, ''])}
        className="h-7 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] bg-[var(--control-bg)] hover:bg-[var(--bg-hover)] border border-dashed border-[var(--control-border)] rounded-md transition-colors cursor-pointer"
      >
        + Add option
      </button>
    </div>
  );
}
