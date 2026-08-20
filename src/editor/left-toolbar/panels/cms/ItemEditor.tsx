// ItemEditor.tsx — Inline editor for a single CMS collection item.
// Shown when an item row is expanded inside CmsOverlay. Built on the shared
// settings-overlay design system (SettingsGroup / SettingsRow / SaveButton)
// so the CMS editor reads with the same minimal visual language as Settings:
// sectioned groups, label-left / control-right rows, hairline dividers, one
// dirty-aware pill Save.

import { useState, useCallback, useEffect, useRef } from 'react';
import type { CollectionSchema, CollectionItem } from '@/shared/types';
import FieldControl from './FieldControl';
import {
  SettingsGroup, SettingsRow, SaveButton, RowButton, RowSelect, ROW_INPUT_CLS,
} from '@/editor/overlays/settings-shared';
import { slugify, isAutoDerivedSlug, uniqueItemSlug } from '@/code/project/cms-ops';
import { trace } from '@/shared/debug-trace';

// ─── Props ──────────────────────────────────────────────────────────────────

interface ItemEditorProps {
  schema: CollectionSchema;
  item: CollectionItem;
  /** Field to scroll to and highlight (set when CMS overlay opened via canvas dbl-click). */
  focusedFieldId?: string | null;
  /** Every OTHER item in the collection — used to preview the conflict suffix
   *  (`-2`, `-3`) live while the slug tracks the title, so the field shows the
   *  value the save will actually persist. Optional: without it the preview is
   *  unsuffixed and `updateCollectionItem` still enforces uniqueness on save. */
  siblingItems?: CollectionItem[];
  onSave: (updatedItem: CollectionItem) => void;
  onCancel: () => void;
}

const STATUS_OPTIONS = [
  { value: 'published', label: 'Published' },
  { value: 'draft', label: 'Draft' },
];

/** JSON fingerprint of an item EXCLUDING `_updatedAt`. That field is
 *  auto-stamped on every save (`updateCollectionItem`), so a freshly-saved
 *  item always differs from the in-editor draft by that one field —
 *  including it in the dirty check would leave the Save button stuck
 *  enabled forever after the first save. */
function itemFingerprint(item: CollectionItem): string {
  const { _updatedAt, ...rest } = item;
  return JSON.stringify(rest);
}

/** Format a system timestamp (`_createdAt`/`_updatedAt`, ISO) for the read-only
 *  Meta rows. Returns an em-dash for missing/invalid values so older items that
 *  predate the stamping still render cleanly. */
function formatMetaDate(iso: string | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

// ─── Component ──────────────────────────────────────────────────────────────

export default function ItemEditor({ schema, item, focusedFieldId, siblingItems, onSave, onCancel }: ItemEditorProps) {
  const [draft, setDraft] = useState<CollectionItem>({ ...item });
  const focusedRef = useRef<HTMLDivElement | null>(null);

  // The TITLE field — first text field, the same rule `addCollectionItem` /
  // `updateCollectionItem` use to pick a slug source.
  const titleFieldId = schema.fields.find(f => f.type === 'text')?.id ?? null;

  // Does the slug still TRACK the title? Seeded from the item as opened, using
  // the same predicate the save path uses, so the editor and the op agree on
  // whether this slug is auto-derived or hand-typed. Flipped off the moment
  // the user types in the slug field; flipped back on if they clear it.
  const [slugLinked, setSlugLinked] = useState(() =>
    isAutoDerivedSlug(String(item._slug ?? ''), titleFieldId ? String(item[titleFieldId] ?? '') : ''));

  /** Slug for `title`, suffixed away from the collection's other items. */
  const deriveSlug = useCallback((title: string): string => {
    const base = title.trim() ? slugify(title) : 'item';
    return uniqueItemSlug(siblingItems ?? [], base, item._id);
  }, [siblingItems, item._id]);

  trace.fn('ItemEditor.render', { itemId: item._id, fieldCount: schema.fields.length, focusedFieldId, slugLinked });

  // Scroll the focused field into view once the editor mounts; the ring
  // pulses via the CSS class animation on its row wrapper below.
  useEffect(() => {
    if (!focusedFieldId || !focusedRef.current) return;
    focusedRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    trace.action('ItemEditor:focus-field', { fieldId: focusedFieldId });
  }, [focusedFieldId]);

  const handleFieldChange = useCallback((fieldId: string, value: any) => {
    trace.action('ItemEditor:fieldChange', { itemId: item._id, fieldId });
    setDraft(prev => {
      const next = { ...prev, [fieldId]: value };
      // Typing the title re-derives the slug LIVE while the two are linked —
      // the Meta row should never sit on a stale `item` placeholder while the
      // title reads "The worst advice…" (user report 2026-07-25).
      if (fieldId === titleFieldId && slugLinked) {
        next._slug = deriveSlug(String(value ?? ''));
        trace.action('ItemEditor:slug-synced', { itemId: item._id, slug: next._slug });
      }
      return next;
    });
  }, [item._id, titleFieldId, slugLinked, deriveSlug]);

  const handleSlugChange = useCallback((raw: string) => {
    // Normalize as they type (the field is a URL key), but never suffix here —
    // rewriting the value mid-keystroke would fight the cursor. The conflict
    // suffix is applied by `updateCollectionItem` on save.
    const typed = raw.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
    // Clearing the field RE-LINKS it to the title (and refills immediately);
    // any other edit is a deliberate override, so the sync stops.
    const relink = typed === '';
    setSlugLinked(relink);
    setDraft(prev => ({
      ...prev,
      _slug: relink && titleFieldId ? deriveSlug(String(prev[titleFieldId] ?? '')) : typed,
    }));
    trace.action('ItemEditor:slug-edited', { itemId: item._id, relink });
  }, [item._id, titleFieldId, deriveSlug]);

  const handleSave = useCallback(() => {
    trace.action('ItemEditor:save', { itemId: item._id });
    onSave(draft);
  }, [draft, item._id, onSave]);

  // Dirty = the draft diverges from the item the editor opened with.
  const dirty = itemFingerprint(draft) !== itemFingerprint(item);

  // ─── Autosave ──────────────────────────────────────────────────────────────
  //
  // The draft used to live only in this component until the Save button was
  // pressed — type a title, reload, and the work was gone because nothing had
  // touched `projectFS` (and so nothing scheduled a backend save either).
  // Every field now commits when focus LEAVES it, plus once more on unmount so
  // closing the overlay / switching item can't drop the last keystrokes.
  // `onSave` funnels into `updateCollectionItem` → `saveCollectionData` →
  // `triggerAutosave` (debounced), so a burst of edits is still one save.
  const latest = useRef({ draft, item, onSave });
  latest.current = { draft, item, onSave };

  const commitIfDirty = useCallback((reason: string) => {
    const { draft: d, item: it, onSave: save } = latest.current;
    if (itemFingerprint(d) === itemFingerprint(it)) return;
    trace.action('ItemEditor:autosave', { itemId: it._id, reason });
    save(d);
  }, []);

  // Focus left one of the editor's controls (React's onBlur IS focusout, so it
  // bubbles from the inputs). Fires for every control type — text, select,
  // date, checkbox — without each one needing its own handler.
  const handleBlurCapture = useCallback(() => {
    commitIfDirty('blur');
  }, [commitIfDirty]);

  useEffect(() => () => commitIfDirty('unmount'), [commitIfDirty]);

  // Adopt EXTERNAL changes to this item (the AI agent, MCP, a collab peer)
  // without clobbering in-progress typing: only reset when the incoming item
  // differs from the last state we ourselves committed. This also picks up
  // whatever `updateCollectionItem` normalized on our own save (e.g. a `-2`
  // slug suffix) — as a state update rather than a remount, so the field the
  // user is typing in keeps focus.
  const committedRef = useRef(itemFingerprint(item));
  useEffect(() => {
    const fp = itemFingerprint(item);
    if (fp === committedRef.current) return;
    committedRef.current = fp;
    setDraft({ ...item });
    trace.action('ItemEditor:adopt-external', { itemId: item._id });
  }, [item]);

  return (
    <div
      className="bg-[var(--bg-panel)] border-b border-[var(--border-light)] pb-1"
      onBlur={handleBlurCapture}
    >
      {/* Content — the collection's own fields. Save lives in this header. */}
      <SettingsGroup
        title="Content"
        action={
          <div className="flex items-center gap-2">
            <RowButton onClick={onCancel} disabled={!dirty}>Cancel</RowButton>
            <SaveButton onClick={handleSave} saving={false} dirty={dirty} />
          </div>
        }
      >
        {schema.fields.map(field => {
          // Rich text / textarea are tall — top-align the label beside them.
          const tall = field.type === 'richtext' || field.type === 'textarea';
          const isFocused = focusedFieldId === field.id;
          // Mirror the Fields sidebar's fallback for an unnamed field.
          const fieldName = field.name || 'Untitled field';
          return (
            <div
              key={field.id}
              ref={isFocused ? focusedRef : undefined}
              className={isFocused ? 'cms-field-focus-ring cut-corners' : ''}
            >
              <SettingsRow
                label={field.required ? `${fieldName} *` : fieldName}
                align={tall ? 'top' : 'center'}
              >
                <FieldControl
                  field={field}
                  value={draft[field.id]}
                  onChange={(val) => handleFieldChange(field.id, val)}
                />
              </SettingsRow>
            </div>
          );
        })}
      </SettingsGroup>

      {/* Meta — URL slug + publish status. */}
      <SettingsGroup title="Meta">
        <SettingsRow label="Slug" htmlFor="cms-item-slug">
          <input
            id="cms-item-slug"
            type="text"
            value={draft._slug ?? ''}
            onChange={(e) => handleSlugChange(e.target.value)}
            className={ROW_INPUT_CLS}
            placeholder="url-slug"
          />
        </SettingsRow>
        <SettingsRow label="Status" htmlFor="cms-item-status">
          <RowSelect
            id="cms-item-status"
            value={draft._status}
            options={STATUS_OPTIONS}
            onChange={(v) => setDraft(prev => ({ ...prev, _status: v as 'published' | 'draft' }))}
          />
        </SettingsRow>
        {/* Created / Updated — system-stamped, read-only (auto on every save). */}
        <SettingsRow label="Created" interactive={false}>
          <span className="block py-1 text-sm text-[var(--text-secondary)] select-text">{formatMetaDate(item._createdAt)}</span>
        </SettingsRow>
        <SettingsRow label="Updated" interactive={false}>
          <span className="block py-1 text-sm text-[var(--text-secondary)] select-text">{formatMetaDate(item._updatedAt)}</span>
        </SettingsRow>
      </SettingsGroup>

      <style>{`
        .cms-field-focus-ring { animation: cms-focus-pulse 1.6s ease-out; }
        @keyframes cms-focus-pulse {
          0%   { box-shadow: 0 0 0 0 var(--accent); }
          30%  { box-shadow: 0 0 0 3px var(--accent); }
          100% { box-shadow: 0 0 0 0 transparent; }
        }
      `}</style>
    </div>
  );
}
