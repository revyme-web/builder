// CmsPanel.tsx — Full CMS panel with three views:
//   1. Collection List — shows all collections with edit/delete + "New Collection"
//   2. Collection Spreadsheet — table of items for the active collection
//   3. Item Detail — form per item with field-type-appropriate controls

import React, { useState, useCallback, useMemo } from 'react';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import {
  collectionSchemasAtom,
  collectionDataAtom,
  activeCmsCollectionAtom,
  editingCmsItemAtom,
} from '@/code/stores/cms-store';
import {
  listCollections,
  deleteCollection,
  cascadeDeleteCollection,
  scanCmsUsage,
  renameCollection,
  duplicateCollection,
  createBlankCollection,
  addCollectionItem,
  updateCollectionItem,
  removeCollectionItem,
  type CmsUsage,
} from '@/code/project/cms-ops';
import { projectVersionAtom } from '@/code/project/project-fs';
import { syncUrlToCms } from '@/code/project/active-file-store';
import type { CollectionSchema, CollectionItem, FieldDefinition } from '@/shared/types';
import { ToolInput, ToolTextArea, ToolSwitch, ToolSelect, ColorInput, RemoveButton } from '../../controls';
import Modal from '@/design-system/Modal';
import { cmsOverlayOpenAtom, activeOverlayCollectionAtom } from './cms/CmsOverlay';
import { cmsEditorOpenAtom, cmsEditorCollectionAtom } from '@/code/stores/cms-editor-store';
import { trace } from '@/shared/debug-trace';
import SectionLabel from '@/design-system/SectionLabel';
import AddButton from '@/design-system/AddButton';
import SidebarRow from '@/design-system/SidebarRow';
import Button from '@/design-system/Button';
import SearchBar from '@/design-system/SearchBar';
import type { DropdownMenuEntry } from '@/design-system/DropdownMenu';
import { CmsIcon } from '@/shared/icons';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Bump projectVersion so derived atoms (collectionSchemasAtom, etc.) re-read from ProjectFS. */
function useCmsRefresh() {
  const bumpVersion = useSetAtom(projectVersionAtom);
  return useCallback(() => {
    bumpVersion(v => v + 1);
    trace.action('cms-panel:refresh');
  }, [bumpVersion]);
}

// ─── Back Button ──────────────────────────────────────────────────────────────

function BackButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="15 18 9 12 15 6" />
      </svg>
      <span className="truncate">{label}</span>
    </button>
  );
}

// ─── View 1: Collection List ──────────────────────────────────────────────────

function CollectionListView({
  onClickCollection, onNewCollection, searchQuery,
  renamingSlug, setRenamingSlug,
}: {
  onClickCollection: (slug: string) => void;
  /** Inline-creates an auto-named collection (Pages-panel style — no modal). */
  onNewCollection: () => void;
  /** Lowercased query string from the top-of-panel SearchBar. Empty string
   *  means search is inactive — list passes through unfiltered so the
   *  existing render path is unchanged. */
  searchQuery: string;
  /** Slug of the collection row currently in inline-rename mode. */
  renamingSlug: string | null;
  setRenamingSlug: (slug: string | null) => void;
}) {
  const schemas = useAtomValue(collectionSchemasAtom);
  const data = useAtomValue(collectionDataAtom);
  const activeEditorSlug = useAtomValue(cmsEditorCollectionAtom);
  const isEditorOpen = useAtomValue(cmsEditorOpenAtom);
  const setEditorOpen = useSetAtom(cmsEditorOpenAtom);
  const setEditorCollection = useSetAtom(cmsEditorCollectionAtom);
  const refresh = useCmsRefresh();

  trace.fn('CmsPanel:CollectionListView.render', { collectionCount: schemas.size, searchQuery });

  const allSlugs = useMemo(() => listCollections(), [schemas]);
  // Match against the user-facing schema name first (what they see in the
  // row); fall back to the raw slug so a search for the URL-shaped name
  // still finds the collection. Case-insensitive.
  const q = searchQuery.trim().toLowerCase();
  const slugs = useMemo(() => {
    if (!q) return allSlugs;
    return allSlugs.filter(slug => {
      const schema = schemas.get(slug);
      const name = (schema?.name ?? slug).toLowerCase();
      return name.includes(q) || slug.toLowerCase().includes(q);
    });
  }, [allSlugs, schemas, q]);

  // Pending-delete state: which collection the user clicked Delete on. The
  // confirm modal below only renders when this is non-null. We stash the
  // scanned usage on the same state so the modal can show counts without
  // re-scanning between hover/click.
  const [pendingDelete, setPendingDelete] = useState<{
    slug: string;
    schemaName: string;
    usage: CmsUsage;
  } | null>(null);

  const handleRenameCommit = useCallback((slug: string, newName: string) => {
    const trimmed = newName.trim();
    // An empty commit is a no-op — the collection keeps its auto-name
    // ("Collection N") or its previous name. The collection is never
    // deleted by the rename flow.
    if (trimmed && trimmed !== schemas.get(slug)?.name) {
      renameCollection(slug, trimmed);
      refresh();
      trace.action('cms-panel:rename-collection', { slug, name: trimmed });
    }
    setRenamingSlug(null);
  }, [schemas, refresh, setRenamingSlug]);

  const handleDuplicateCollection = useCallback((slug: string) => {
    const newSlug = duplicateCollection(slug);
    if (newSlug) {
      refresh();
      trace.action('cms-panel:duplicate-collection', { from: slug, to: newSlug });
    }
  }, [refresh]);

  const requestDeleteCollection = useCallback((slug: string) => {
    trace.action('cms-panel:request-delete-collection', { slug });
    const schema = schemas.get(slug);
    const usage = scanCmsUsage(slug);
    setPendingDelete({
      slug,
      schemaName: schema?.name ?? slug,
      usage,
    });
  }, [schemas]);

  const confirmDeleteCollection = useCallback(() => {
    if (!pendingDelete) return;
    const { slug, usage } = pendingDelete;
    trace.action('cms-panel:confirm-delete-collection', {
      slug,
      bindingCount: usage.bindings.length,
      detailPageCount: usage.detailPages.length,
      itemCount: usage.itemCount,
    });
    if (usage.bindings.length === 0 && usage.detailPages.length === 0) {
      // Fast path — nothing depends on this collection. Skip the heavy scan
      // pipeline; just drop the data + schema files.
      deleteCollection(slug);
    } else {
      cascadeDeleteCollection(slug);
    }

    // If the CMS editor overlay is open on the collection we just deleted,
    // re-route it to the nearest surviving collection — or close it
    // entirely when that was the last one.
    if (isEditorOpen && activeEditorSlug === slug) {
      const remaining = allSlugs.filter(s => s !== slug);
      if (remaining.length === 0) {
        setEditorOpen(false);
        setEditorCollection(null);
        syncUrlToCms(null);
        trace.action('cms-panel:editor-closed-after-delete', { slug });
      } else {
        // The slot the deleted collection occupied now holds the next
        // collection; if it was last, clamp back to the new last one.
        const idx = allSlugs.indexOf(slug);
        const nearest = remaining[Math.min(idx, remaining.length - 1)];
        setEditorCollection(nearest);
        syncUrlToCms(nearest);
        trace.action('cms-panel:editor-rerouted-after-delete', { from: slug, to: nearest });
      }
    }

    setPendingDelete(null);
    refresh();
  }, [pendingDelete, refresh, isEditorOpen, activeEditorSlug, allSlugs, setEditorOpen, setEditorCollection]);

  const cancelDeleteCollection = useCallback(() => {
    if (!pendingDelete) return;
    trace.action('cms-panel:cancel-delete-collection', { slug: pendingDelete.slug });
    setPendingDelete(null);
  }, [pendingDelete]);

  if (slugs.length === 0) {
    // Two empty-states: (a) no collections at all → onboarding copy + CTA;
    // (b) collections exist but the active search filtered them all out →
    // simpler "no matches" copy without the CTA (clicking + wouldn't help
    // — the user is trying to find an existing one). The CTA still renders
    // in the (a) branch so first-run users have a clear next step.
    const hasAnyCollections = allSlugs.length > 0;
    return (
      <div className="flex flex-col items-center gap-3 px-4 pt-6 text-center">
        <CmsIcon className="w-5 h-5 text-[var(--text-disabled)]" />
        <p className="text-xs font-medium text-[var(--text-secondary)]">
          {hasAnyCollections ? 'No collections match' : 'No collections yet'}
        </p>
        <p className="text-[10px] text-[var(--text-disabled)] max-w-[180px] leading-relaxed">
          {hasAnyCollections
            ? 'Try a different search term.'
            : 'Create a collection to manage structured content like blog posts, team members, or products.'}
        </p>
        {!hasAnyCollections && (
        <button
          onClick={onNewCollection}
          // Accent tokens, not hardcoded blue — --accent-fg is the per-theme
          // "label on accent" pairing (near-black on the gold/Amber themes).
          className="flex items-center gap-1.5 cut-corners bg-[var(--accent)] px-3 py-1.5 text-[11px] font-medium text-[var(--accent-fg,#0d1017)] transition-[filter] hover:brightness-110 cursor-pointer"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          New Collection
        </button>
        )}
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="flex-1 overflow-y-auto scrollbar-hide px-2">
        {slugs.map(slug => {
          const schema = schemas.get(slug);
          const items = data.get(slug) ?? [];
          const menuItems: DropdownMenuEntry[] = [
            { id: 'rename', label: 'Rename', onClick: () => setRenamingSlug(slug) },
            { id: 'duplicate', label: 'Duplicate', onClick: () => handleDuplicateCollection(slug) },
            { type: 'separator' },
            { id: 'delete', label: 'Delete', onClick: () => requestDeleteCollection(slug) },
          ];
          return (
            <SidebarRow
              key={slug}
              icon={<CmsIcon width={14} height={14} />}
              label={schema?.name || slug}
              iconColor="var(--text-secondary)"
              isActive={isEditorOpen && slug === activeEditorSlug}
              onClick={() => onClickCollection(slug)}
              menuItems={menuItems}
              right={<span className="text-[10px] text-[var(--text-disabled)]">{items.length}</span>}
              inlineEdit={renamingSlug === slug ? {
                // Pre-fill the current name (the auto-name for a fresh
                // collection); SidebarRow selects it so a keystroke
                // overwrites, and clicking away keeps it.
                initialValue: schema?.name ?? slug,
                onCommit: (val) => handleRenameCommit(slug, val),
              } : undefined}
            />
          );
        })}
      </div>

      {/* Cascade-delete confirm modal — shown only when a delete is pending. */}
      <DeleteCollectionModal pending={pendingDelete} onConfirm={confirmDeleteCollection} onCancel={cancelDeleteCollection} />
    </div>
  );
}

// ─── Delete confirm modal ────────────────────────────────────────────────────

/**
 * Shows the cascade-delete preview: how many items, bound `.map()` blocks,
 * and detail pages will be removed if the user confirms. Lists each binding
 * + detail page by file path so the user can identify what's affected.
 */
function DeleteCollectionModal({
  pending,
  onConfirm,
  onCancel,
}: {
  pending: { slug: string; schemaName: string; usage: CmsUsage } | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!pending) return null;
  const { schemaName, usage } = pending;
  const hasCascade = usage.bindings.length > 0 || usage.detailPages.length > 0;

  // Group bindings by file for a cleaner list ("home page · 2 blocks").
  const bindingsByFile = new Map<string, number>();
  for (const b of usage.bindings) {
    bindingsByFile.set(b.filePath, (bindingsByFile.get(b.filePath) ?? 0) + 1);
  }

  return (
    <Modal isOpen onClose={onCancel} title={`Delete "${schemaName}"`} width={420}>
      <div className="px-4 py-3 flex flex-col gap-3 text-xs text-[var(--text-primary)]">
        <p className="text-[var(--text-secondary)]">
          {hasCascade
            ? 'Deleting this collection will also remove the elements bound to it.'
            : 'This collection has no usages. The schema and all items will be removed.'}
        </p>

        <div className="cut-corners cut-border [--cut-border-color:var(--border-light)] bg-[var(--bg-elevated)] border border-[var(--border-light)] divide-y divide-[var(--border-light)]">
          <div className="flex items-center justify-between px-3 py-2">
            <span className="text-[var(--text-secondary)]">Items</span>
            <span className="font-mono text-[var(--text-primary)]">{usage.itemCount}</span>
          </div>
          <div className="flex items-center justify-between px-3 py-2">
            <span className="text-[var(--text-secondary)]">Bound elements</span>
            <span className="font-mono text-[var(--text-primary)]">{usage.bindings.length}</span>
          </div>
          <div className="flex items-center justify-between px-3 py-2">
            <span className="text-[var(--text-secondary)]">Detail pages</span>
            <span className="font-mono text-[var(--text-primary)]">{usage.detailPages.length}</span>
          </div>
        </div>

        {(bindingsByFile.size > 0 || usage.detailPages.length > 0) && (
          <div className="flex flex-col gap-1.5 max-h-40 overflow-y-auto">
            {[...bindingsByFile.entries()].map(([filePath, count]) => (
              <div key={`b-${filePath}`} className="flex items-center justify-between px-2 py-1 rounded bg-[var(--bg-elevated)]">
                <span className="truncate text-[10px] text-[var(--text-secondary)]" title={filePath}>{filePath}</span>
                <span className="text-[10px] font-mono text-[var(--text-disabled)] shrink-0 ml-2">
                  {count} block{count === 1 ? '' : 's'}
                </span>
              </div>
            ))}
            {usage.detailPages.map(filePath => (
              <div key={`d-${filePath}`} className="flex items-center justify-between px-2 py-1 rounded bg-[var(--bg-elevated)]">
                <span className="truncate text-[10px] text-[var(--text-secondary)]" title={filePath}>{filePath}</span>
                <span className="text-[10px] font-mono text-[var(--text-disabled)] shrink-0 ml-2">detail page</span>
              </div>
            ))}
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-1">
          <Button variant="secondary" size="sm" onClick={onCancel}>Cancel</Button>
          <button
            onClick={onConfirm}
            className="px-3 py-1.5 text-[11px] font-medium cut-corners bg-red-600 hover:bg-red-500 text-white transition-colors cursor-pointer"
          >
            Delete
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ─── View 2: Collection Spreadsheet ───────────────────────────────────────────

function CollectionSpreadsheetView({ slug }: { slug: string }) {
  const schemas = useAtomValue(collectionSchemasAtom);
  const data = useAtomValue(collectionDataAtom);
  const setActiveCollection = useSetAtom(activeCmsCollectionAtom);
  const setEditingItem = useSetAtom(editingCmsItemAtom);
  const refresh = useCmsRefresh();

  const schema = schemas.get(slug);
  const items = data.get(slug) ?? [];

  trace.fn('CmsPanel:SpreadsheetView.render', { slug, fieldCount: schema?.fields.length ?? 0, itemCount: items.length });

  const handleBack = useCallback(() => {
    trace.action('cms-panel:spreadsheet-back');
    setActiveCollection(null);
  }, [setActiveCollection]);

  const handleClickRow = useCallback((itemId: string) => {
    trace.action('cms-panel:edit-item', { slug, itemId });
    setEditingItem(itemId);
  }, [slug, setEditingItem]);

  const handleAddItem = useCallback(() => {
    trace.action('cms-panel:add-item', { slug });
    const newItem = addCollectionItem(slug, {});
    refresh();
    setEditingItem(newItem._id);
  }, [slug, refresh, setEditingItem]);

  const handleDeleteItem = useCallback((itemId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    trace.action('cms-panel:delete-item', { slug, itemId });
    removeCollectionItem(slug, itemId);
    refresh();
  }, [slug, refresh]);

  if (!schema) {
    return (
      <div className="flex-1 flex items-center justify-center text-xs text-[var(--text-disabled)]">
        Schema not found for "{slug}"
      </div>
    );
  }

  // Show at most 3 fields in the table
  const visibleFields = schema.fields.slice(0, 3);

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-[var(--border-light)]">
        <BackButton onClick={handleBack} label={schema.name} />
      </div>

      {/* Table */}
      <div className="flex-1 overflow-y-auto scrollbar-hide">
        {/* Table header */}
        <div className="flex items-center px-3 py-1.5 border-b border-[var(--border-light)] bg-[var(--grid-line)]">
          {visibleFields.map(f => (
            <span key={f.id} className="flex-1 text-[10px] font-bold text-[var(--text-disabled)] uppercase truncate">
              {f.name}
            </span>
          ))}
          <span className="w-5" /> {/* space for delete button */}
        </div>

        {/* Rows */}
        {items.length === 0 ? (
          <div className="px-3 py-4 text-xs text-[var(--text-disabled)] text-center">
            No items yet
          </div>
        ) : (
          items.map(item => (
            <div
              key={item._id}
              onClick={() => handleClickRow(item._id)}
              className="flex items-center px-3 py-2 border-b border-[var(--border-light)] cursor-pointer hover:bg-[var(--grid-line)] transition-colors group"
            >
              {visibleFields.map(f => (
                <span key={f.id} className="flex-1 text-xs text-[var(--text-primary)] truncate pr-2">
                  {renderCellValue(item[f.id], f)}
                </span>
              ))}
              <span className="w-5 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                <RemoveButton onClick={(e) => handleDeleteItem(item._id, e)} />
              </span>
            </div>
          ))
        )}
      </div>

      {/* Add Item button at bottom */}
      <div className="p-3 border-t border-[var(--border-light)]">
        <button
          onClick={handleAddItem}
          className="w-full flex items-center justify-center gap-1.5 cut-corners cut-border hover:[--cut-border-color:var(--control-border-hover)] bg-[var(--grid-line)] border border-[var(--control-border)] [--cut-border-color:var(--control-border)] hover:border-[var(--control-border-hover)] px-3 py-1.5 text-[11px] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          Add Item
        </button>
      </div>
    </div>
  );
}

/** Render a cell value based on field type. */
function renderCellValue(value: any, field: FieldDefinition): string {
  if (value === undefined || value === null) return '-';
  if (field.type === 'boolean') return value ? 'Yes' : 'No';
  if (field.type === 'image') return value ? '(image)' : '-';
  if (field.type === 'color') return String(value);
  return String(value).slice(0, 40);
}

// ─── View 3: Item Detail ──────────────────────────────────────────────────────

function ItemDetailView({ slug, itemId }: { slug: string; itemId: string }) {
  const schemas = useAtomValue(collectionSchemasAtom);
  const data = useAtomValue(collectionDataAtom);
  const setEditingItem = useSetAtom(editingCmsItemAtom);
  const refresh = useCmsRefresh();

  const schema = schemas.get(slug);
  const items = data.get(slug) ?? [];
  const item = items.find(i => i._id === itemId);

  trace.fn('CmsPanel:ItemDetailView.render', { slug, itemId, found: !!item });

  const handleBack = useCallback(() => {
    trace.action('cms-panel:item-detail-back');
    setEditingItem(null);
  }, [setEditingItem]);

  const handleFieldChange = useCallback((fieldId: string, value: any) => {
    trace.action('cms-panel:update-field', { slug, itemId, fieldId, valueType: typeof value });
    updateCollectionItem(slug, itemId, { [fieldId]: value });
    refresh();
  }, [slug, itemId, refresh]);

  const handleStatusChange = useCallback((status: string) => {
    trace.action('cms-panel:update-status', { slug, itemId, status });
    updateCollectionItem(slug, itemId, { _status: status as 'published' | 'draft' });
    refresh();
  }, [slug, itemId, refresh]);

  const handleSlugChange = useCallback((newSlug: string) => {
    trace.action('cms-panel:update-slug', { slug, itemId, newSlug });
    updateCollectionItem(slug, itemId, { _slug: newSlug });
    refresh();
  }, [slug, itemId, refresh]);

  const handleDeleteItem = useCallback(() => {
    if (!confirm('Delete this item?')) return;
    trace.action('cms-panel:delete-item-from-detail', { slug, itemId });
    removeCollectionItem(slug, itemId);
    refresh();
    setEditingItem(null);
  }, [slug, itemId, refresh, setEditingItem]);

  if (!schema || !item) {
    return (
      <div className="flex-1 flex items-center justify-center text-xs text-[var(--text-disabled)]">
        Item not found
      </div>
    );
  }

  // Derive a display name from the first text field or _slug
  const firstTextField = schema.fields.find(f => f.type === 'text');
  const displayName = firstTextField ? String(item[firstTextField.id] || item._slug || 'Untitled') : item._slug || 'Untitled';

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-[var(--border-light)]">
        <BackButton onClick={handleBack} label={displayName} />
      </div>

      {/* Fields */}
      <div className="flex-1 overflow-y-auto scrollbar-hide p-3 flex flex-col gap-3">
        {schema.fields.map(field => (
          <FieldControl
            key={field.id}
            field={field}
            value={item[field.id]}
            onChange={(val) => handleFieldChange(field.id, val)}
            allSchemas={schemas}
            allData={data}
          />
        ))}

        {/* Separator */}
        <div className="h-px bg-[var(--border-light)] my-1" />

        {/* Slug */}
        <div className="flex flex-col gap-1">
          <span className="text-[10px] font-bold text-[var(--text-disabled)] uppercase">Slug</span>
          <ToolInput
            value={item._slug ?? ''}
            onChange={handleSlugChange}
            text
          />
        </div>

        {/* Status */}
        <div className="flex flex-col gap-1">
          <span className="text-[10px] font-bold text-[var(--text-disabled)] uppercase">Status</span>
          <ToolSelect
            value={item._status ?? 'published'}
            onChange={handleStatusChange}
            options={[
              { value: 'published', label: 'Published' },
              { value: 'draft', label: 'Draft' },
            ]}
          />
        </div>

        {/* Delete button */}
        <div className="pt-2">
          <button
            onClick={handleDeleteItem}
            className="w-full flex items-center justify-center gap-1.5 cut-corners cut-border bg-red-600/10 border border-red-500/20 hover:bg-red-600/20 px-3 py-1.5 text-[11px] font-medium text-red-400 hover:text-red-300 transition-colors cursor-pointer"
          >
            Delete Item
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Field Control — renders the right control per field type ──────────────────

interface FieldControlProps {
  field: FieldDefinition;
  value: any;
  onChange: (value: any) => void;
  allSchemas: Map<string, CollectionSchema>;
  allData: Map<string, CollectionItem[]>;
}

function FieldControl({ field, value, onChange, allSchemas, allData }: FieldControlProps) {
  const stringVal = value !== undefined && value !== null ? String(value) : '';

  switch (field.type) {
    case 'text':
      return (
        <div className="flex flex-col gap-1">
          <span className="text-[10px] font-bold text-[var(--text-disabled)] uppercase">{field.name}</span>
          <ToolInput value={stringVal} onChange={onChange} text />
        </div>
      );

    case 'richtext':
      // Plain multiline string — rich text (HTML) does not resolve in the builder
      // (text-node bindings render values verbatim). No formatting toolbar.
      return (
        <div className="flex flex-col gap-1">
          <span className="text-[10px] font-bold text-[var(--text-disabled)] uppercase">{field.name}</span>
          <ToolTextArea value={stringVal} onChange={onChange} rows={8} />
        </div>
      );

    case 'number':
      return (
        <div className="flex flex-col gap-1">
          <span className="text-[10px] font-bold text-[var(--text-disabled)] uppercase">{field.name}</span>
          <ToolInput value={stringVal || '0'} onChange={(v) => onChange(Number(v) || 0)} step={1} />
        </div>
      );

    case 'boolean':
      return (
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-bold text-[var(--text-disabled)] uppercase">{field.name}</span>
          <ToolSwitch value={!!value} onChange={onChange} />
        </div>
      );

    case 'date':
      return (
        <div className="flex flex-col gap-1">
          <span className="text-[10px] font-bold text-[var(--text-disabled)] uppercase">{field.name}</span>
          <ToolInput value={stringVal} onChange={onChange} text />
        </div>
      );

    case 'image':
      return (
        <div className="flex flex-col gap-1">
          <span className="text-[10px] font-bold text-[var(--text-disabled)] uppercase">{field.name}</span>
          <ToolInput value={stringVal} onChange={onChange} text />
          {stringVal && (
            <div className="w-full h-16 rounded bg-[var(--grid-line)] border border-[var(--control-border)] overflow-hidden">
              <img
                src={stringVal}
                alt={field.name}
                className="w-full h-full object-cover"
                onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
              />
            </div>
          )}
        </div>
      );

    case 'link':
      return (
        <div className="flex flex-col gap-1">
          <span className="text-[10px] font-bold text-[var(--text-disabled)] uppercase">{field.name}</span>
          <ToolInput value={stringVal} onChange={onChange} text />
        </div>
      );

    case 'color':
      return (
        <div className="flex flex-col gap-1">
          <span className="text-[10px] font-bold text-[var(--text-disabled)] uppercase">{field.name}</span>
          <ColorInput value={stringVal || '#000000'} onChange={onChange} />
        </div>
      );

    case 'enum':
      return (
        <div className="flex flex-col gap-1">
          <span className="text-[10px] font-bold text-[var(--text-disabled)] uppercase">{field.name}</span>
          <ToolSelect
            value={stringVal}
            onChange={onChange}
            options={(field.options ?? []).map(o => ({ value: o, label: o }))}
          />
        </div>
      );

    case 'reference': {
      const refSlug = field.referenceCollection;
      const refItems = refSlug ? (allData.get(refSlug) ?? []) : [];
      const refSchema = refSlug ? allSchemas.get(refSlug) : null;
      const labelField = refSchema?.fields.find(f => f.type === 'text');
      return (
        <div className="flex flex-col gap-1">
          <span className="text-[10px] font-bold text-[var(--text-disabled)] uppercase">{field.name}</span>
          <ToolSelect
            value={stringVal}
            onChange={onChange}
            options={[
              { value: '', label: '(none)' },
              ...refItems.map(ri => ({
                value: ri._id,
                label: labelField ? String(ri[labelField.id] || ri._slug) : ri._slug,
              })),
            ]}
          />
        </div>
      );
    }

    default:
      return (
        <div className="flex flex-col gap-1">
          <span className="text-[10px] font-bold text-[var(--text-disabled)] uppercase">{field.name}</span>
          <ToolInput value={stringVal} onChange={onChange} text />
        </div>
      );
  }
}

// ─── Main CmsPanel ────────────────────────────────────────────────────────────

export default function CmsPanel() {
  const [activeCollection, setActiveCollection] = useAtom(activeCmsCollectionAtom);
  const [editingItem, setEditingItem] = useAtom(editingCmsItemAtom);
  const setCmsOverlayOpen = useSetAtom(cmsOverlayOpenAtom);
  const setOverlayCollection = useSetAtom(activeOverlayCollectionAtom);
  const setCmsEditorOpen = useSetAtom(cmsEditorOpenAtom);
  const setCmsEditorCollection = useSetAtom(cmsEditorCollectionAtom);
  // Inline collection-create state — `+` drops an auto-named row straight
  // into rename mode. Lifted here because the `+` button lives in this
  // header while the row lives in CollectionListView.
  const [renamingSlug, setRenamingSlug] = useState<string | null>(null);
  // Top-of-panel search query — matches the SearchBar + divider chrome the
  // Library / Pages / Layers panels use so the four left-toolbar panels
  // share one header pattern. Filters only the collection list view
  // (matches CollectionListView's source list); spreadsheet + item-detail
  // views own their own breadcrumb headers above, so the search row stays
  // collection-list-only.
  const [searchQuery, setSearchQuery] = useState('');
  const refresh = useCmsRefresh();

  // Refresh on mount
  React.useEffect(() => {
    refresh();
  }, [refresh]);

  trace.fn('CmsPanel.render', { activeCollection, editingItem });

  const handleClickCollection = useCallback((slug: string) => {
    setCmsEditorCollection(slug);
    setCmsEditorOpen(true);
    // The overlay's URL-sync effect picks up the slug change on next render,
    // but call it here too so the URL updates in the same frame as the click.
    syncUrlToCms(slug);
    trace.action('cms-panel:open-editor', { slug });
  }, [setCmsEditorCollection, setCmsEditorOpen]);

  // Inline-create an auto-named collection ("Collection N"): refresh the
  // list, open its editor overlay, and drop the row into rename mode so
  // the auto-name is selected and ready to override.
  const handleCreateCollectionInline = useCallback(() => {
    const slug = createBlankCollection();
    refresh();
    setRenamingSlug(slug);
    handleClickCollection(slug);
    trace.action('cms-panel:create-collection-inline', { slug });
  }, [refresh, handleClickCollection]);

  return (
    <div className="flex flex-col h-full">
      {/* Top-of-panel search — matches the Library panel chrome (SearchBar
          + thin divider) so the left-toolbar panels share a consistent
          header pattern. Spacing math mirrors LibraryPanel verbatim:
          12 px above (pt-3), 6 px below to the divider (pb-1.5), then
          another 6 px (mt-1.5) before the divider lands and stacks
          directly against the SectionLabel below (mb-0). */}
      <div className="px-3 pt-3 pb-1.5 shrink-0">
        <SearchBar
          value={searchQuery}
          onChange={(v) => {
            trace.action('cms-panel:search', { query: v });
            setSearchQuery(v);
          }}
          placeholder="Search collections…"
        />
      </div>
      <div data-tool-divider className="h-px bg-[var(--border-light)] mx-3 mt-1.5 mb-0" />

      <SectionLabel size="md" right={<AddButton onClick={handleCreateCollectionInline} title="New collection" />}>CMS</SectionLabel>

      <CollectionListView
        onClickCollection={handleClickCollection}
        onNewCollection={handleCreateCollectionInline}
        searchQuery={searchQuery}
        renamingSlug={renamingSlug}
        setRenamingSlug={setRenamingSlug}
      />
    </div>
  );
}
