// FieldControl.tsx — Renders the appropriate input control based on FieldDefinition type.
// Used by ItemEditor inside the CMS overlay.

import { useState, useCallback, useRef } from 'react';
import { useAtomValue } from 'jotai';
import type { FieldDefinition } from '@/shared/types';
import { collectionSchemasAtom, collectionDataAtom } from '@/code/stores/cms-store';
import { cmsItemLabel } from '@/code/project/cms-ops';
import { trace } from '@/shared/debug-trace';
import ImageSearchModal from '../../../ui/ImageSearchModal';
import ToolPopup from '../../../ui/ToolPopup';
import ColorPicker from '../../../ui/ColorPicker';

// ─── Shared Input Classes ───────────────────────────────────────────────────

const INPUT_BASE =
  'w-full h-8 px-3 text-sm bg-[var(--grid-line)] border border-[var(--control-border)] rounded-[var(--radius-md)] text-[var(--text-primary)] placeholder:text-[var(--text-disabled)] focus:outline-none focus:border-[var(--accent)]';

const TEXTAREA_BASE =
  'w-full px-3 py-2 text-sm bg-[var(--grid-line)] border border-[var(--control-border)] rounded-[var(--radius-md)] text-[var(--text-primary)] placeholder:text-[var(--text-disabled)] focus:outline-none focus:border-[var(--accent)] resize-y';

const SELECT_BASE =
  'w-full h-8 px-2 text-sm bg-[var(--grid-line)] border border-[var(--control-border)] rounded-[var(--radius-md)] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)] cursor-pointer';

// ─── Props ──────────────────────────────────────────────────────────────────

interface FieldControlProps {
  field: FieldDefinition;
  value: any;
  onChange: (value: any) => void;
}

// ─── Tag Pills (for tags field type) ────────────────────────────────────────

function TagPills({ tags, onRemove }: { tags: string[]; onRemove: (tag: string) => void }) {
  if (tags.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1 mt-1.5">
      {tags.map(tag => (
        <span
          key={tag}
          className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] bg-[var(--accent)]/15 text-[var(--accent)] rounded-full"
        >
          {tag}
          <span
            onClick={() => onRemove(tag)}
            className="cursor-pointer hover:text-white transition-colors"
          >
            &times;
          </span>
        </span>
      ))}
    </div>
  );
}

// ─── Toggle Switch ──────────────────────────────────────────────────────────

function ToggleSwitch({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div
      onClick={() => onChange(!value)}
      className={`relative w-9 h-5 rounded-full cursor-pointer transition-colors ${
        value ? 'bg-[var(--accent)]' : 'bg-[var(--grid-line)] border border-[var(--control-border)]'
      }`}
    >
      <div
        className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${
          value ? 'translate-x-[18px]' : 'translate-x-0.5'
        }`}
      />
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────────────────────

export default function FieldControl({ field, value, onChange }: FieldControlProps) {
  trace.fn('FieldControl.render', { fieldId: field.id, fieldType: field.type });

  const handleChange = useCallback((newVal: any) => {
    trace.action('FieldControl:change', { fieldId: field.id, fieldType: field.type });
    onChange(newVal);
  }, [field.id, field.type, onChange]);

  switch (field.type) {
    case 'text':
      return (
        <input
          type="text"
          value={value ?? ''}
          onChange={(e) => handleChange(e.target.value)}
          placeholder={field.name}
          className={INPUT_BASE}
        />
      );

    case 'textarea':
      return (
        <textarea
          value={value ?? ''}
          onChange={(e) => handleChange(e.target.value)}
          placeholder={field.name}
          rows={3}
          className={TEXTAREA_BASE}
        />
      );

    case 'richtext':
      // Rich text (HTML) does NOT resolve in the builder — a CMS field bound to
      // a text node ({item.body}) renders its value verbatim, so HTML tags show
      // as literal characters on the live site. CMS long-text content is a plain
      // multiline string (no formatting toolbar). See DANGEROUS_INNER_HTML oracle rule.
      return (
        <textarea
          value={value ?? ''}
          onChange={(e) => handleChange(e.target.value)}
          placeholder={field.name}
          rows={8}
          className={TEXTAREA_BASE}
        />
      );

    case 'number':
      return (
        <input
          type="number"
          value={value ?? ''}
          onChange={(e) => handleChange(e.target.value === '' ? '' : Number(e.target.value))}
          placeholder={field.name}
          className={INPUT_BASE}
          style={{ colorScheme: 'dark' }}
        />
      );

    case 'boolean':
      return <ToggleSwitch value={!!value} onChange={handleChange} />;

    case 'date':
      return (
        <input
          type="date"
          value={value ?? ''}
          onChange={(e) => handleChange(e.target.value)}
          className={INPUT_BASE}
          style={{ colorScheme: 'dark' }}
        />
      );

    case 'url':
    case 'link':
      return (
        <input
          type="url"
          value={value ?? ''}
          onChange={(e) => handleChange(e.target.value)}
          placeholder="https://..."
          className={INPUT_BASE}
        />
      );

    case 'color':
      return <ColorFieldControl value={value ?? ''} onChange={handleChange} name={field.name} />;

    case 'enum':
      return (
        <select
          value={value ?? ''}
          onChange={(e) => handleChange(e.target.value)}
          className={SELECT_BASE}
          style={{ colorScheme: 'dark' }}
        >
          <option value="">Select {field.name}...</option>
          {(field.options ?? []).map(opt => (
            <option key={opt} value={opt}>{opt}</option>
          ))}
        </select>
      );

    case 'tags':
      return <TagsFieldControl value={value} onChange={handleChange} name={field.name} />;

    case 'slug':
      return (
        <input
          type="text"
          value={value ?? ''}
          onChange={(e) => handleChange(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-'))}
          placeholder="url-slug"
          className={INPUT_BASE}
        />
      );

    case 'image':
      return <ImageFieldControl value={value ?? ''} onChange={handleChange} name={field.name} />;

    case 'file':
      return (
        <input
          type="text"
          value={value ?? ''}
          onChange={(e) => handleChange(e.target.value)}
          placeholder="File URL..."
          className={INPUT_BASE}
        />
      );

    case 'reference':
      return <ReferencePicker field={field} value={value} onChange={handleChange} multi={false} />;

    case 'multi-reference':
      return <ReferencePicker field={field} value={value} onChange={handleChange} multi />;

    default:
      return (
        <input
          type="text"
          value={value ?? ''}
          onChange={(e) => handleChange(e.target.value)}
          placeholder={field.name}
          className={INPUT_BASE}
        />
      );
  }
}

// ─── Color Field ────────────────────────────────────────────────────────────

/** Color field — the swatch opens the editor's own ColorPicker, anchored to it.
 *
 *  It used to build a DETACHED `<input type="color">` and `.click()` it. The element was never
 *  inserted into the document, so it had no layout box and the browser anchored its native picker
 *  at the viewport origin — the picker appeared pinned to the top-left corner no matter where the
 *  swatch was (live find 2026-07-30). Beyond the position, that path also bypassed the editor's
 *  own picker entirely (no eyedropper parity, no alpha, OS-native chrome inside our UI), so the
 *  fix is to use the shared ColorPicker + ToolPopup the rest of the editor uses rather than to
 *  patch the hack. ToolPopup portals at z-index 100001, above the CMS overlay's 10000. */
function ColorFieldControl({ value, onChange, name }: { value: string; onChange: (v: string) => void; name: string }) {
  const [open, setOpen] = useState(false);
  const [live, setLive] = useState<string | null>(null);   // drag preview, not yet committed
  const swatchRef = useRef<HTMLButtonElement>(null);
  const shown = live ?? value;

  return (
    <div className="flex items-center gap-2">
      <button
        ref={swatchRef}
        type="button"
        title={`${name} — pick a colour`}
        onClick={() => setOpen(o => !o)}
        className="w-8 h-8 rounded-[var(--radius-md)] border border-[var(--control-border)] hover:border-[var(--border-focus)] shrink-0 cursor-pointer transition-colors"
        style={{ background: shown || '#000' }}
      />
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="#000000"
        className={INPUT_BASE}
      />
      <ToolPopup isOpen={open} onClose={() => { setOpen(false); setLive(null); }} title={name} anchorRef={swatchRef} width={280}>
        <ColorPicker
          value={value || '#000000'}
          // onChange fires every drag frame — keep it to the local swatch preview and only
          // write the item on commit, so a drag doesn't queue a JSON write per frame.
          onChange={setLive}
          onChangeEnd={(c) => { setLive(null); onChange(c); }}
        />
      </ToolPopup>
    </div>
  );
}

// ─── Image Field ────────────────────────────────────────────────────────────

/** Image field control — opens the same media picker the Image tool uses
 *  (Unsplash search + URL paste + Upload), instead of forcing the user to
 *  paste a URL by hand. CMS image-type fields store the bare URL (no
 *  `url(...)` wrapping — that's a CSS-only convention used by ImagePickerInput
 *  for `backgroundImage` slots), so the modal's `onSelect(url)` payload
 *  drops straight into `onChange`. */
function ImageFieldControl({ value, onChange, name }: { value: string; onChange: (v: string) => void; name: string }) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const hasImage = !!value;

  const handleClear = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onChange('');
    trace.action('cms-field:image:clear', { field: name });
  }, [onChange, name]);

  const handleSelect = useCallback((picked: string) => {
    onChange(picked);
    setPickerOpen(false);
    trace.action('cms-field:image:select', { field: name, url: picked.slice(0, 80) });
  }, [onChange, name]);

  // Single visual: the preview tile IS the picker trigger. Empty state
  // renders a "Choose image…" placeholder with the same dimensions so the
  // form layout doesn't jump when the user picks/clears. URL string is
  // intentionally NOT shown — the user requested just the image preview;
  // hovering the tile surfaces the URL via the native title tooltip + a
  // floating × button to clear.
  return (
    <div className="relative inline-block group">
      <button
        type="button"
        onClick={() => setPickerOpen(true)}
        title={hasImage ? value : 'Choose image…'}
        className="w-16 h-16 rounded-[var(--radius-md)] border border-[var(--control-border)] hover:border-[var(--border-focus)] overflow-hidden bg-[var(--grid-line)] transition-colors cursor-pointer flex items-center justify-center"
      >
        {hasImage ? (
          <img
            src={value}
            alt={name}
            className="w-full h-full object-cover"
            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
          />
        ) : (
          <span className="text-[10px] text-[var(--text-disabled)] px-1 text-center leading-tight">Choose image…</span>
        )}
      </button>
      {hasImage && (
        <button
          type="button"
          onClick={handleClear}
          title="Clear image"
          className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-[var(--bg-canvas)] border border-[var(--control-border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] text-[10px] leading-none flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
        >
          ×
        </button>
      )}
      <ImageSearchModal
        isOpen={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={handleSelect}
      />
    </div>
  );
}

// ─── Tags Field ─────────────────────────────────────────────────────────────

function TagsFieldControl({ value, onChange, name }: { value: any; onChange: (v: string[]) => void; name: string }) {
  const [inputVal, setInputVal] = useState('');
  const tags: string[] = Array.isArray(value) ? value : (typeof value === 'string' && value ? value.split(',').map(t => t.trim()).filter(Boolean) : []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      const tag = inputVal.trim();
      if (tag && !tags.includes(tag)) {
        const next = [...tags, tag];
        onChange(next);
        trace.action('FieldControl:tags:add', { tag, count: next.length });
      }
      setInputVal('');
    } else if (e.key === 'Backspace' && !inputVal && tags.length > 0) {
      const next = tags.slice(0, -1);
      onChange(next);
      trace.action('FieldControl:tags:removeLast', { count: next.length });
    }
  }, [inputVal, tags, onChange]);

  const handleRemove = useCallback((tag: string) => {
    const next = tags.filter(t => t !== tag);
    onChange(next);
    trace.action('FieldControl:tags:remove', { tag, count: next.length });
  }, [tags, onChange]);

  return (
    <div>
      <input
        type="text"
        value={inputVal}
        onChange={(e) => setInputVal(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Type and press Enter..."
        className={INPUT_BASE}
      />
      <TagPills tags={tags} onRemove={handleRemove} />
    </div>
  );
}

// ─── Reference Field ─────────────────────────────────────────────────────────

/** Reference / multi-reference value editor — picks actual item(s) from the
 *  field's target collection (`field.referenceCollection`), showing each
 *  item's display label rather than a raw ID. Single mode renders a
 *  dropdown; multi mode renders an "add" dropdown plus removable pills. */
function ReferencePicker({ field, value, onChange, multi }: {
  field: FieldDefinition;
  value: any;
  onChange: (v: any) => void;
  multi: boolean;
}) {
  const schemas = useAtomValue(collectionSchemasAtom);
  const allData = useAtomValue(collectionDataAtom);
  const refSlug = field.referenceCollection;
  const refSchema = refSlug ? schemas.get(refSlug) ?? null : null;
  const refItems = refSlug ? allData.get(refSlug) ?? [] : [];

  if (!refSlug || !refSchema) {
    return (
      <div className="text-xs italic text-[var(--text-disabled)] px-1 py-1.5">
        No collection set — choose one in the field's settings.
      </div>
    );
  }

  // ── Single reference — one dropdown ──
  if (!multi) {
    // When the item has no value of its own, fall back to the field's
    // configured default so the picker shows it pre-selected.
    const effective = (value ?? field.defaultValue) ?? '';
    return (
      <select
        value={effective}
        onChange={(e) => onChange(e.target.value)}
        className={SELECT_BASE}
        style={{ colorScheme: 'dark' }}
      >
        <option value="">Select item…</option>
        {refItems.map(it => (
          <option key={it._id} value={it._id}>{cmsItemLabel(it, refSchema)}</option>
        ))}
      </select>
    );
  }

  // ── Multi-reference — add-dropdown + removable pills ──
  const selected: string[] = Array.isArray(value)
    ? value
    : (typeof value === 'string' && value ? value.split(',').map(s => s.trim()).filter(Boolean) : []);
  const available = refItems.filter(it => !selected.includes(it._id));
  const labelFor = (id: string) => {
    const it = refItems.find(x => x._id === id);
    return it ? cmsItemLabel(it, refSchema) : id;
  };

  return (
    <div>
      <select
        value=""
        onChange={(e) => { if (e.target.value) onChange([...selected, e.target.value]); }}
        className={SELECT_BASE}
        style={{ colorScheme: 'dark' }}
        disabled={available.length === 0}
      >
        <option value="">{available.length ? 'Add item…' : 'All items added'}</option>
        {available.map(it => (
          <option key={it._id} value={it._id}>{cmsItemLabel(it, refSchema)}</option>
        ))}
      </select>
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1.5">
          {selected.map(id => (
            <span
              key={id}
              className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] bg-[var(--accent)]/15 text-[var(--accent)] rounded-full"
            >
              {labelFor(id)}
              <span
                onClick={() => onChange(selected.filter(x => x !== id))}
                className="cursor-pointer hover:text-white transition-colors"
              >
                &times;
              </span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
