// CmsEditorOverlay.tsx — Full-screen CMS collection editor overlay.
// Collections live in the left panel (CmsPanel). This overlay is a
// master-detail view with an Items / Fields segmented control: an inner
// sidebar lists either the collection's items or its schema fields, and the
// main pane shows the selected item's editor or the selected field's
// settings — mirroring the Settings Overlay's nav-left / content-right layout.

import { useState, useCallback, useMemo, useEffect, useRef, type ReactNode, type CSSProperties } from 'react';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import {
  cmsEditorOpenAtom,
  cmsEditorCollectionAtom,
  cmsEditorExpandedItemAtom,
  cmsEditorFocusedFieldAtom,
} from '@/code/stores/cms-editor-store';
import { collectionSchemasAtom, collectionDataAtom } from '@/code/stores/cms-store';
import {
  addCollectionItem,
  updateCollectionItem,
  removeCollectionItem,
  reorderCollectionItems,
  reorderCollectionFields,
  saveCollectionSchema,
  addCollectionField,
  updateCollectionField,
  cmsItemLabel,
  FIELD_TYPES,
} from '@/code/project/cms-ops';
import { projectVersionAtom } from '@/code/project/project-fs';
import { syncUrlToCms } from '@/code/project/active-file-store';
import type { CollectionItem, FieldDefinition } from '@/shared/types';
import ItemEditor from './ItemEditor';
import FieldSettings from './FieldSettings';
import CollectionSelector from './CollectionSelector';
import CmsAiPanel, { SparkleIcon } from './CmsAiPanel';
import Breadcrumb from '@/design-system/Breadcrumb';
import Button from '@/design-system/Button';
import SidebarRow from '@/design-system/SidebarRow';
import DropdownMenu, { type DropdownMenuEntry } from '@/design-system/DropdownMenu';
import ToolSegmentedControl from '@/editor/controls/ToolSegmentedControl';
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy, useSortable, arrayMove } from '@dnd-kit/sortable';
import { restrictToVerticalAxis } from '@dnd-kit/modifiers';
import { CSS } from '@dnd-kit/utilities';
import { trace } from '@/shared/debug-trace';
import { pushHistory } from '@/code/mutation/history';
import { fieldDropTargets } from './cms-field-reorder';

type SidebarMode = 'items' | 'fields';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Human label for a field type ('richtext' → 'Rich Text'). */
function typeLabel(type: FieldDefinition['type']): string {
  return FIELD_TYPES.find(t => t.value === type)?.label ?? type;
}

/** Shared "+" icon for the sidebar's New Item / New Field buttons. */
const plusIcon = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);

/** Sidebar search input — identical styling for the Items and Fields lists. */
function sidebarSearchInput(value: string, onChange: (v: string) => void, placeholder: string) {
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="w-full h-[var(--control-height-sm)] px-2.5 text-xs bg-[var(--control-bg)] border border-[var(--control-border)] [--cut-border-color:var(--control-border)] cut-corners cut-border focus:[--cut-border-color:var(--accent)] text-[var(--text-primary)] placeholder:text-[var(--text-disabled)] focus:outline-none focus:border-[var(--accent)]"
    />
  );
}

/** Published/draft status dot shown on item rows (plain + sortable). */
function itemStatusDot(item: CollectionItem) {
  return (
    <span
      className="w-2 h-2 rounded-full"
      style={{ background: item._status === 'published' ? '#4ade80' : 'var(--text-disabled)' }}
    />
  );
}

// ─── Sortable item row ────────────────────────────────────────────────────────
// A SidebarRow wired for dnd-kit drag-to-reorder. The WHOLE row is the drag source
// (listeners spread onto the row), so there's no grip handle. The PointerSensor's
// 4px activation distance keeps a plain click as select; the `…` menu stops its own
// pointerdown (EllipsisMenu) so opening it never arms a drag. Reordering rewrites
// the collection's stored item array, which is the EXACT order a collection-list
// `.map()` renders — so list output reorders to match.
// Shared by the Items AND the Fields tab (same dnd mechanics for both lists).
// `disabled` PINS a row (the collection's TITLE field): it can't be picked up
// (dnd-kit `disabled.draggable`) but stays a drop target, so a NON-text field
// can still be dropped above it; text fields never reach it because the Fields
// DndContext filters those targets out (`fieldDropTargets`). dnd-kit's
// attributes are always spread — they carry `aria-disabled` + the button
// role/tabIndex so the pinned row keeps its place in the tab order — only the
// pointer/keyboard LISTENERS are withheld.
function SortableCmsRow({
  id, icon, label, isActive, onSelect, menuItems, right, disabled, title,
}: {
  id: string;
  icon: ReactNode;
  label: string;
  isActive: boolean;
  onSelect: () => void;
  menuItems: DropdownMenuEntry[];
  right?: ReactNode;
  disabled?: boolean;
  title?: string;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    disabled: disabled ? { draggable: true, droppable: false } : undefined,
  });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition: isDragging ? 'none' : transition,
    opacity: isDragging ? 0.4 : 1,
    zIndex: isDragging ? 10 : 1,
    position: 'relative',
  };
  return (
    <SidebarRow
      ref={setNodeRef}
      style={style}
      icon={icon}
      label={label}
      isActive={isActive}
      onClick={onSelect}
      menuItems={menuItems}
      right={right}
      title={title}
      {...attributes}
      {...(disabled ? {} : listeners)}
    />
  );
}

// ─── Main Overlay ───────────────────────────────────────────────────────────

export default function CmsEditorOverlay() {
  const [isOpen, setOpen] = useAtom(cmsEditorOpenAtom);
  const [activeSlug] = useAtom(cmsEditorCollectionAtom);
  // `cmsEditorExpandedItemAtom` is the SELECTED item — the one in the pane.
  const [selectedItemId, setSelectedItemId] = useAtom(cmsEditorExpandedItemAtom);
  const [focusedFieldId, setFocusedFieldId] = useAtom(cmsEditorFocusedFieldAtom);
  const schemas = useAtomValue(collectionSchemasAtom);
  const allData = useAtomValue(collectionDataAtom);
  const bumpVersion = useSetAtom(projectVersionAtom);

  const [searchQuery, setSearchQuery] = useState('');
  const [fieldSearchQuery, setFieldSearchQuery] = useState('');
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>('items');
  const [selectedFieldId, setSelectedFieldId] = useState<string | null>(null);
  const [newFieldMenuOpen, setNewFieldMenuOpen] = useState(false);
  const [aiPanelOpen, setAiPanelOpen] = useState(true);
  const newFieldBtnRef = useRef<HTMLButtonElement>(null);

  const schema = activeSlug ? schemas.get(activeSlug) ?? null : null;
  const items = activeSlug ? allData.get(activeSlug) ?? [] : [];

  // Reset search when the collection changes.
  useEffect(() => {
    setSearchQuery('');
    setFieldSearchQuery('');
  }, [activeSlug]);

  // Keep URL in sync with overlay state (replaceState — no history spam).
  useEffect(() => {
    if (!isOpen) return;
    syncUrlToCms(activeSlug, selectedItemId, focusedFieldId);
  }, [isOpen, activeSlug, selectedItemId, focusedFieldId]);

  // Auto-clear the field highlight after a short delay — a one-shot cue.
  useEffect(() => {
    if (!focusedFieldId) return;
    const id = window.setTimeout(() => setFocusedFieldId(null), 1800);
    return () => window.clearTimeout(id);
  }, [focusedFieldId, setFocusedFieldId]);

  // Default the item selection to the first item so the pane is never blank.
  // A deep-linked item (set before open) is left intact.
  //
  // Bails while `items` is empty. On a reload the overlay can open a frame or
  // two before `collectionDataAtom` has the collection's rows, and "no item
  // matches the id" would then be indistinguishable from "the URL's item is
  // stale" — nulling a perfectly good ?item= deep link. An empty collection
  // has nothing to select either way, so skipping costs nothing.
  useEffect(() => {
    if (!isOpen || !activeSlug || items.length === 0) return;
    if (!selectedItemId || !items.some(i => i._id === selectedItemId)) {
      setSelectedItemId(items[0]?._id ?? null);
    }
  }, [isOpen, activeSlug, items, selectedItemId, setSelectedItemId]);

  // Default the field selection to the first field when in Fields mode.
  useEffect(() => {
    if (!isOpen || sidebarMode !== 'fields' || !schema) return;
    if (!selectedFieldId || !schema.fields.some(f => f.id === selectedFieldId)) {
      setSelectedFieldId(schema.fields[0]?.id ?? null);
    }
  }, [isOpen, sidebarMode, schema, selectedFieldId]);

  const handleClose = useCallback(() => {
    setOpen(false);
    setSelectedItemId(null);
    setFocusedFieldId(null);
    syncUrlToCms(null);
    trace.action('cms-editor:close');
  }, [setOpen, setSelectedItemId, setFocusedFieldId]);

  // Escape to close
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); handleClose(); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isOpen, handleClose]);

  // Filter items by search query.
  const filteredItems = useMemo(() => {
    if (!searchQuery.trim()) return items;
    const q = searchQuery.toLowerCase();
    return items.filter(item => {
      for (const val of Object.values(item)) {
        if (typeof val === 'string' && val.toLowerCase().includes(q)) return true;
      }
      return false;
    });
  }, [items, searchQuery]);

  // Filter schema fields by search query (matches the field name).
  const filteredFields = useMemo(() => {
    if (!schema) return [];
    if (!fieldSearchQuery.trim()) return schema.fields;
    const q = fieldSearchQuery.toLowerCase();
    return schema.fields.filter(f => (f.name || '').toLowerCase().includes(q));
  }, [schema, fieldSearchQuery]);

  // ── Item handlers ──────────────────────────────────────────────────────────

  const handleAddItem = useCallback(() => {
    if (!activeSlug || !schema) return;
    const defaults: Record<string, any> = {};
    for (const field of schema.fields) {
      if (field.defaultValue !== undefined) defaults[field.id] = field.defaultValue;
      else if (field.type === 'boolean') defaults[field.id] = false;
      else if (field.type === 'tags') defaults[field.id] = [];
    }
    const newItem = addCollectionItem(activeSlug, { ...defaults, _status: 'draft' });
    bumpVersion(v => v + 1);
    setSelectedItemId(newItem._id);
    trace.action('cms-editor:add-item', { slug: activeSlug });
  }, [activeSlug, schema, bumpVersion, setSelectedItemId]);

  const handleSaveItem = useCallback((updated: CollectionItem) => {
    if (!activeSlug) return;
    // No slug re-derivation here. The editor already keeps `_slug` in step with
    // the title while the two are LINKED, and `updateCollectionItem` normalizes
    // + de-duplicates whatever arrives. The old unconditional
    // `_slug = slugify(title)` clobbered hand-typed slugs on every save AND, by
    // always putting `_slug` in the update, skipped the op's uniqueness pass.
    const { _id, _createdAt, ...updates } = updated;
    updateCollectionItem(activeSlug, updated._id, updates);
    bumpVersion(v => v + 1);
    trace.action('cms-editor:save-item', { slug: activeSlug, itemId: updated._id });
  }, [activeSlug, bumpVersion]);

  const handleDeleteItem = useCallback((itemId: string) => {
    if (!activeSlug) return;
    removeCollectionItem(activeSlug, itemId);
    bumpVersion(v => v + 1);
    if (selectedItemId === itemId) setSelectedItemId(null);
    trace.action('cms-editor:delete-item', { slug: activeSlug, itemId });
  }, [activeSlug, selectedItemId, bumpVersion, setSelectedItemId]);

  // ── Drag-to-reorder items ───────────────────────────────────────────────────
  // 4px activation distance so a plain click still selects (no accidental drag).
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } })
  );

  const handleReorderItems = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (!activeSlug || !over || active.id === over.id) return;
    const ids = items.map(i => i._id);
    const oldIdx = ids.indexOf(active.id as string);
    const newIdx = ids.indexOf(over.id as string);
    if (oldIdx === -1 || newIdx === -1) return;
    reorderCollectionItems(activeSlug, arrayMove(ids, oldIdx, newIdx));
    bumpVersion(v => v + 1);
    // Own undo entry (history snapshots the whole ProjectFS) — otherwise the
    // reorder rode into the next unrelated canvas entry.
    pushHistory('');
    trace.action('cms-editor:reorder-items', { slug: activeSlug, from: oldIdx, to: newIdx });
  }, [activeSlug, items, bumpVersion]);

  // ── Drag-to-reorder fields ──────────────────────────────────────────────────
  // The schema's field array IS the display order (Fields tab, the item editor's
  // Content form, binding pickers). One invariant is kept: the collection's TITLE
  // is "the first text-type field" — it names items in the sidebar, seeds the auto
  // slug and gets the required star — so it is pinned (not draggable) and no other
  // text field may be dropped above it. Any other field can move freely.
  const titleFieldId = useMemo(() => schema?.fields.find(f => f.type === 'text')?.id ?? null, [schema]);

  const handleReorderFields = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (!activeSlug || !schema || !over || active.id === over.id) return;
    const ids = schema.fields.map(f => f.id);
    const oldIdx = ids.indexOf(active.id as string);
    let newIdx = ids.indexOf(over.id as string);
    if (oldIdx === -1 || newIdx === -1) return;
    if (active.id === titleFieldId) return; // pinned
    const moved = schema.fields[oldIdx];
    const titleIdx = titleFieldId ? ids.indexOf(titleFieldId) : -1;
    if (moved.type === 'text' && titleIdx !== -1 && newIdx <= titleIdx) {
      // A text field can't become the new "first text field" — land right after the title.
      newIdx = titleIdx + (oldIdx < titleIdx ? 0 : 1);
      if (newIdx === oldIdx) return;
    }
    const changed = reorderCollectionFields(activeSlug, arrayMove(ids, oldIdx, newIdx));
    if (changed) { bumpVersion(v => v + 1); pushHistory(''); }
    trace.action('cms-editor:reorder-fields', { slug: activeSlug, from: oldIdx, to: newIdx, changed });
  }, [activeSlug, schema, titleFieldId, bumpVersion]);

  // The drag PREVIEW must obey the same rule as the commit: while a text field
  // is dragged, rows at/above the title are not drop targets, so dnd-kit never
  // shows it landing there and then snapping back (review find 2026-09-09).
  const fieldsCollision = useCallback((args: Parameters<typeof closestCenter>[0]) => {
    const ids = schema?.fields.map(f => f.id) ?? [];
    const moved = schema?.fields.find(f => f.id === args.active.id);
    const allowed = fieldDropTargets(ids, titleFieldId, moved?.type === 'text');
    return closestCenter({ ...args, droppableContainers: args.droppableContainers.filter(c => allowed.has(String(c.id))) });
  }, [schema, titleFieldId]);

  // ── Field (schema) handlers ────────────────────────────────────────────────

  const handleAddField = useCallback((type: FieldDefinition['type'], referenceCollection?: string) => {
    if (!activeSlug || !schema) return;
    // addCollectionField generates an identifier-safe (camelCase) id —
    // shared with the AI agent's add_field so every field id is valid for
    // `item.fieldId` access in generated pages. Reference types pass the
    // target collection so it's set without a trip to field settings.
    const id = addCollectionField(activeSlug, { name: '', type, referenceCollection });
    if (!id) return;
    bumpVersion(v => v + 1);
    setSelectedFieldId(id);
    setNewFieldMenuOpen(false);
    trace.action('cms-editor:add-field', { slug: activeSlug, type, referenceCollection, id });
  }, [activeSlug, schema, bumpVersion]);

  const handleUpdateField = useCallback((fieldId: string, patch: Partial<FieldDefinition>) => {
    if (!activeSlug || !schema) return;
    // Route through the shared op instead of hand-rolling the schema write: it
    // re-reads the schema (no stale closure) and enforces the field-NAME
    // uniqueness rule, so renaming a field to one that already exists lands as
    // "Content 2" here exactly as it does for the AI agent and the plugin SDK.
    updateCollectionField(activeSlug, fieldId, patch);
    bumpVersion(v => v + 1);
    trace.action('cms-editor:update-field', { slug: activeSlug, fieldId });
  }, [activeSlug, schema, bumpVersion]);

  const handleRemoveField = useCallback((fieldId: string) => {
    if (!activeSlug || !schema) return;
    saveCollectionSchema(activeSlug, {
      ...schema,
      fields: schema.fields.filter(f => f.id !== fieldId),
    });
    bumpVersion(v => v + 1);
    if (selectedFieldId === fieldId) setSelectedFieldId(null);
    trace.action('cms-editor:remove-field', { slug: activeSlug, fieldId });
  }, [activeSlug, schema, selectedFieldId, bumpVersion]);

  if (!isOpen) return null;

  const collectionName = schema?.name ?? activeSlug ?? 'CMS';
  const selectedItem = selectedItemId ? items.find(i => i._id === selectedItemId) ?? null : null;
  const selectedField = selectedFieldId ? schema?.fields.find(f => f.id === selectedFieldId) ?? null : null;

  return (
    <>
      {/* Header bar */}
      <div
        className="fixed z-[10000] border-b border-[var(--border-light)] bg-[var(--bg-surface)] flex items-center justify-between px-4"
        style={{ top: 0, left: 308, right: 260, height: 52 }}
      >
        <Breadcrumb segments={[
          {
            label: 'Back',
            icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>,
            onClick: handleClose,
          },
          {
            label: collectionName,
            icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" /><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" /></svg>,
            color: 'var(--accent-text)',
          },
        ]} />
        {/* AI panel toggle — re-opens the docked Vibe panel after it's hidden. */}
        <button
          onClick={() => setAiPanelOpen(v => !v)}
          title={aiPanelOpen ? 'Hide AI panel' : 'Show AI panel'}
          className={`flex items-center gap-1.5 px-2.5 h-7 cut-corners text-xs font-medium transition-colors cursor-pointer ${
            aiPanelOpen
              ? 'bg-[var(--accent)]/15 text-[var(--accent-text)]'
              : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
          }`}
        >
          <SparkleIcon size={13} />
          Vibe
        </button>
      </div>

      {/* Body — master-detail: items/fields sidebar + editor pane. */}
      <div
        className="fixed z-[9000] bg-[var(--bg-panel)] flex"
        style={{ top: 52, left: 308, right: 0, bottom: 0 }}
      >
        {!activeSlug || !schema ? (
          <div className="flex-1 flex items-center justify-center text-xs text-[var(--text-disabled)]">
            Select a collection
          </div>
        ) : (
          <>
            {/* ── Sidebar ───────────────────────────────────────────────── */}
            <div className="w-64 shrink-0 border-r border-[var(--border-light)] bg-[var(--bg-surface)] flex flex-col">
              {/* Items / Fields segmented control */}
              <div className="px-3 pt-3 pb-2 shrink-0">
                <ToolSegmentedControl
                  value={sidebarMode}
                  onChange={(v) => setSidebarMode(v as SidebarMode)}
                  size="sm"
                  options={[{ value: 'items', label: 'Items' }, { value: 'fields', label: 'Fields' }]}
                />
              </div>
              <div className="h-px bg-[var(--border-light)] mx-3 shrink-0" />

              {sidebarMode === 'items' ? (
                <>
                  <div className="px-3 py-2 shrink-0">
                    <Button
                      variant="primary"
                      size="sm"
                      className="w-full"
                      onClick={handleAddItem}
                      icon={plusIcon}
                    >
                      New Item
                    </Button>
                  </div>
                  <div className="h-px bg-[var(--border-light)] mx-3 shrink-0" />
                  <div className="px-3 py-2 shrink-0">
                    {sidebarSearchInput(searchQuery, setSearchQuery, 'Search items...')}
                  </div>
                  <div className="h-px bg-[var(--border-light)] mx-3 shrink-0" />
                  <div className="flex-1 overflow-y-auto scrollbar-hide px-3 pt-1.5">
                    {filteredItems.length === 0 ? (
                      <div className="px-2 py-8 text-center text-[11px] text-[var(--text-disabled)]">
                        {searchQuery.trim() ? `No results for "${searchQuery}"` : 'No items yet'}
                      </div>
                    ) : searchQuery.trim() ? (
                      // While filtering, reordering a subset is ambiguous — render
                      // plain (non-draggable) rows. Clear the search to reorder.
                      filteredItems.map(item => (
                        <SidebarRow
                          key={item._id}
                          icon={itemStatusDot(item)}
                          label={cmsItemLabel(item, schema)}
                          isActive={item._id === selectedItemId}
                          onClick={() => setSelectedItemId(item._id)}
                          menuItems={[{ id: 'delete', label: 'Delete', onClick: () => handleDeleteItem(item._id) }]}
                        />
                      ))
                    ) : (
                      // Drag to reorder — the stored item-array order IS the order a
                      // collection-list `.map()` renders, so the list reorders to match.
                      <DndContext
                        sensors={sensors}
                        collisionDetection={closestCenter}
                        modifiers={[restrictToVerticalAxis]}
                        onDragEnd={handleReorderItems}
                      >
                        <SortableContext items={items.map(i => i._id)} strategy={verticalListSortingStrategy}>
                          {items.map(item => (
                            <SortableCmsRow
                              key={item._id}
                              id={item._id}
                              icon={itemStatusDot(item)}
                              label={cmsItemLabel(item, schema)}
                              isActive={item._id === selectedItemId}
                              onSelect={() => setSelectedItemId(item._id)}
                              menuItems={[{ id: 'delete', label: 'Delete', onClick: () => handleDeleteItem(item._id) }]}
                            />
                          ))}
                        </SortableContext>
                      </DndContext>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <div className="px-3 py-2 shrink-0">
                    <Button
                      ref={newFieldBtnRef}
                      variant="primary"
                      size="sm"
                      className="w-full"
                      onClick={() => setNewFieldMenuOpen(true)}
                      icon={plusIcon}
                    >
                      New Field
                    </Button>
                    <DropdownMenu
                      isOpen={newFieldMenuOpen}
                      onClose={() => setNewFieldMenuOpen(false)}
                      anchorRef={newFieldBtnRef}
                      position="right-start"
                      items={FIELD_TYPES.map((ft): DropdownMenuEntry => {
                        // Reference / Multi-Reference open a submenu of
                        // collections — picking one creates the field with
                        // that target already applied.
                        if (ft.value === 'reference' || ft.value === 'multi-reference') {
                          return {
                            id: ft.value,
                            label: ft.label,
                            onClick: () => {}, // parent item — the submenu acts
                            submenuItems: [...schemas.values()].map(c => ({
                              id: `${ft.value}:${c.slug}`,
                              label: c.name,
                              onClick: () => handleAddField(ft.value, c.slug),
                            })),
                          };
                        }
                        return {
                          id: ft.value,
                          label: ft.label,
                          onClick: () => handleAddField(ft.value),
                        };
                      })}
                    />
                  </div>
                  <div className="h-px bg-[var(--border-light)] mx-3 shrink-0" />
                  <div className="px-3 py-2 shrink-0 flex flex-col gap-2">
                    <CollectionSelector />
                    {sidebarSearchInput(fieldSearchQuery, setFieldSearchQuery, 'Search fields...')}
                  </div>
                  <div className="h-px bg-[var(--border-light)] mx-3 shrink-0" />
                  <div className="flex-1 overflow-y-auto scrollbar-hide px-3 pt-1.5">
                    {filteredFields.length === 0 ? (
                      <div className="px-2 py-8 text-center text-[11px] text-[var(--text-disabled)]">
                        {fieldSearchQuery.trim() ? `No results for "${fieldSearchQuery}"` : 'No fields yet'}
                      </div>
                    ) : fieldSearchQuery.trim() ? (
                      // While filtering, reordering a subset is ambiguous — plain rows
                      // (same rule as the Items tab). Clear the search to reorder.
                      filteredFields.map(field => {
                        const menuItems: DropdownMenuEntry[] = [
                          { id: 'delete', label: 'Delete', onClick: () => handleRemoveField(field.id) },
                        ];
                        return (
                          <SidebarRow
                            key={field.id}
                            icon={<span className="w-2 h-2 rounded-full bg-[var(--text-disabled)]" />}
                            label={field.name || 'Untitled field'}
                            isActive={field.id === selectedFieldId}
                            onClick={() => setSelectedFieldId(field.id)}
                            right={<span className="text-[10px] text-[var(--text-disabled)]">{typeLabel(field.type)}</span>}
                            menuItems={menuItems}
                          />
                        );
                      })
                    ) : (
                      // Drag to reorder — the schema field order IS the order the item
                      // editor's Content form (and every field list) shows. Same dnd
                      // mechanics as the Items tab; the title field is pinned.
                      <DndContext
                        sensors={sensors}
                        collisionDetection={fieldsCollision}
                        modifiers={[restrictToVerticalAxis]}
                        onDragEnd={handleReorderFields}
                      >
                        <SortableContext items={schema!.fields.map(f => f.id)} strategy={verticalListSortingStrategy}>
                          {schema!.fields.map(field => {
                            const isTitle = field.id === titleFieldId;
                            return (
                              <SortableCmsRow
                                key={field.id}
                                id={field.id}
                                icon={<span className="w-2 h-2 rounded-full bg-[var(--text-disabled)]" />}
                                label={field.name || 'Untitled field'}
                                isActive={field.id === selectedFieldId}
                                onSelect={() => setSelectedFieldId(field.id)}
                                right={<span className="text-[10px] text-[var(--text-disabled)]">{typeLabel(field.type)}</span>}
                                menuItems={[{ id: 'delete', label: 'Delete', onClick: () => handleRemoveField(field.id) }]}
                                disabled={isTitle}
                                title={isTitle ? 'Title field — stays the first text field (names items and seeds the slug)' : undefined}
                              />
                            );
                          })}
                        </SortableContext>
                      </DndContext>
                    )}
                  </div>
                </>
              )}
            </div>

            {/* ── Editor pane ───────────────────────────────────────────── */}
            <div className="flex-1 overflow-y-auto scrollbar-hide bg-[var(--bg-panel)]">
              {sidebarMode === 'items' ? (
                selectedItem ? (
                  <div className="max-w-2xl mx-auto mt-2">
                    <ItemEditor
                      // Key on _id ALONE. `_updatedAt` used to be in the key so
                      // an external edit (AI agent, MCP) remounted the editor
                      // fresh — but every field now autosaves on blur, which
                      // bumps `_updatedAt` too, so that key would tear the
                      // editor down mid-edit and drop focus on each tab-out.
                      // ItemEditor adopts external changes via an effect
                      // instead (see its `committedRef` guard), which updates
                      // the values without disturbing the focused field.
                      key={selectedItem._id}
                      schema={schema}
                      item={selectedItem}
                      siblingItems={items}
                      focusedFieldId={focusedFieldId}
                      onSave={handleSaveItem}
                      onCancel={() => setSelectedItemId(null)}
                    />
                  </div>
                ) : (
                  <div className="h-full flex items-center justify-center text-xs text-[var(--text-disabled)]">
                    Select an item to edit
                  </div>
                )
              ) : selectedField ? (
                <div className="max-w-2xl mx-auto mt-2">
                  <FieldSettings
                    // Key on the field's full content: any change to it
                    // (a commit, or the AI agent editing it) remounts the
                    // pane fresh so it never shows a stale draft.
                    key={JSON.stringify(selectedField)}
                    field={selectedField}
                    collections={[...schemas.values()]}
                    collectionData={allData}
                    onChange={(patch) => handleUpdateField(selectedField.id, patch)}
                  />
                </div>
              ) : (
                <div className="h-full flex items-center justify-center text-xs text-[var(--text-disabled)]">
                  Select a field to edit
                </div>
              )}
            </div>

            {/* ── AI panel (docked right column) ───────────────────────── */}
            {aiPanelOpen && (
              <CmsAiPanel collectionName={collectionName} onClose={() => setAiPanelOpen(false)} />
            )}
          </>
        )}
      </div>
    </>
  );
}
