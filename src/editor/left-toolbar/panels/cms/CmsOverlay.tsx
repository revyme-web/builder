// CmsOverlay.tsx — Full-screen modal for managing CMS collection items.
// Same portal/backdrop/header/footer style as TranslationsOverlay.

import { useState, useCallback, useMemo, useEffect } from 'react';
import { atom, useAtomValue, useSetAtom } from 'jotai';
import { createPortal } from 'react-dom';
import { collectionSchemasAtom, collectionDataAtom } from '@/code/stores/cms-store';
import {
  addCollectionItem,
  updateCollectionItem,
  removeCollectionItem,
} from '@/code/project/cms-ops';
import { projectVersionAtom } from '@/code/project/project-fs';
import type { CollectionSchema, CollectionItem } from '@/shared/types';
import ItemEditor from './ItemEditor';
import { trace } from '@/shared/debug-trace';

// ─── Exported Atoms ─────────────────────────────────────────────────────────

/** Controls whether the CMS overlay is open. */
export const cmsOverlayOpenAtom = atom(false);

/** Which collection slug is being managed in the overlay. */
export const activeOverlayCollectionAtom = atom<string | null>(null);

// ─── Item Row ───────────────────────────────────────────────────────────────

interface ItemRowProps {
  item: CollectionItem;
  schema: CollectionSchema;
  /** The collection's full item list — ItemEditor previews the slug conflict
   *  suffix against it while the slug tracks the title. */
  allItems: CollectionItem[];
  isExpanded: boolean;
  onToggle: () => void;
  onSave: (updated: CollectionItem) => void;
  onDelete: () => void;
}

function ItemRow({ item, schema, allItems, isExpanded, onToggle, onSave, onDelete }: ItemRowProps) {
  trace.fn('CmsOverlay:ItemRow.render', { itemId: item._id, isExpanded });

  // Derive display title from first text field or _slug
  const firstTextField = schema.fields.find(f => f.type === 'text');
  const title = (firstTextField && item[firstTextField.id])
    ? String(item[firstTextField.id])
    : item._slug || item._id;

  // Preview: first 2-3 non-title fields
  const previewFields = schema.fields
    .filter(f => f.id !== firstTextField?.id && item[f.id] != null && item[f.id] !== '')
    .slice(0, 3);

  const isPublished = item._status === 'published';

  return (
    <div className="border-b border-[var(--border-light)]">
      {/* Row header */}
      <div
        onClick={onToggle}
        className="group flex items-center gap-3 px-5 py-3 hover:bg-[var(--bg-hover)] transition-colors cursor-pointer"
      >
        {/* Expand indicator */}
        <span className="text-sm text-[var(--text-disabled)] w-4 text-center shrink-0">
          {isExpanded ? '\u2212' : '+'}
        </span>

        {/* Title */}
        <span className="text-sm font-medium text-[var(--text-primary)] truncate min-w-0 flex-shrink-0 max-w-[200px]">
          {title}
        </span>

        {/* Status badge */}
        <span
          className={`text-[10px] px-2 py-0.5 rounded-full font-medium shrink-0 ${
            isPublished
              ? 'bg-green-500/10 text-green-400'
              : 'bg-[var(--grid-line)] text-[var(--text-disabled)]'
          }`}
        >
          {isPublished ? 'Published' : 'Draft'}
        </span>

        {/* Preview fields */}
        <div className="flex items-center gap-3 flex-1 min-w-0 overflow-hidden">
          {previewFields.map(f => {
            let display = String(item[f.id]);
            if (display.length > 40) display = display.slice(0, 40) + '...';
            return (
              <span key={f.id} className="text-xs text-[var(--text-disabled)] truncate max-w-[150px]">
                <span className="text-[var(--text-secondary)]">{f.name}:</span> {display}
              </span>
            );
          })}
        </div>

        {/* Slug */}
        <span className="text-[10px] text-[var(--text-disabled)] shrink-0 font-mono">
          /{item._slug}
        </span>

        {/* Delete button */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          className="w-6 h-6 flex items-center justify-center text-[var(--text-disabled)] hover:text-red-400 hover:bg-red-500/10 rounded transition-colors cursor-pointer opacity-0 group-hover:opacity-100 shrink-0"
          title="Delete item"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      {/* Expanded editor */}
      {isExpanded && (
        <ItemEditor
          schema={schema}
          item={item}
          siblingItems={allItems}
          onSave={onSave}
          onCancel={onToggle}
        />
      )}
    </div>
  );
}

// ─── Empty State ────────────────────────────────────────────────────────────

function EmptyState({ hasSearch, query }: { hasSearch: boolean; query: string }) {
  if (hasSearch) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2">
        <span className="text-xs text-[var(--text-disabled)]">No results for "{query}"</span>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center justify-center h-full gap-2">
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-[var(--text-disabled)]">
        <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
        <line x1="3" y1="9" x2="21" y2="9" />
        <line x1="9" y1="21" x2="9" y2="9" />
      </svg>
      <span className="text-xs text-[var(--text-disabled)]">No items yet</span>
      <span className="text-[10px] text-[var(--text-disabled)]">Click "Add Item" to create your first entry</span>
    </div>
  );
}

// ─── Main Overlay ───────────────────────────────────────────────────────────

export default function CmsOverlay() {
  const isOpen = useAtomValue(cmsOverlayOpenAtom);
  const setOpen = useSetAtom(cmsOverlayOpenAtom);
  const collectionSlug = useAtomValue(activeOverlayCollectionAtom);
  const schemas = useAtomValue(collectionSchemasAtom);
  const allData = useAtomValue(collectionDataAtom);
  const bumpVersion = useSetAtom(projectVersionAtom);

  // State
  const [expandedItemId, setExpandedItemId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  // Derived data
  const schema = collectionSlug ? schemas.get(collectionSlug) ?? null : null;
  const items = collectionSlug ? allData.get(collectionSlug) ?? [] : [];

  // Reset state on open
  useEffect(() => {
    if (!isOpen) return;
    trace.action('CmsOverlay:open', { collectionSlug });
    setExpandedItemId(null);
    setSearchQuery('');
  }, [isOpen, collectionSlug]);

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        trace.action('CmsOverlay:close-escape');
        setOpen(false);
      }
    };
    window.addEventListener('keydown', handleKey, true);
    return () => window.removeEventListener('keydown', handleKey, true);
  }, [isOpen, setOpen]);

  // Filter items by search query
  const filteredItems = useMemo(() => {
    if (!searchQuery.trim()) return items;
    const q = searchQuery.toLowerCase();
    return items.filter(item => {
      // Search across all string values
      for (const val of Object.values(item)) {
        if (typeof val === 'string' && val.toLowerCase().includes(q)) return true;
      }
      return false;
    });
  }, [items, searchQuery]);

  // ─── Handlers ─────────────────────────────────────────────────────────────

  const handleClose = useCallback(() => {
    trace.action('CmsOverlay:close');
    setOpen(false);
  }, [setOpen]);

  const handleAddItem = useCallback(() => {
    if (!collectionSlug || !schema) return;
    trace.action('CmsOverlay:addItem', { collectionSlug });

    // Create item with default values from schema
    const defaults: Record<string, any> = {};
    for (const field of schema.fields) {
      if (field.defaultValue !== undefined) {
        defaults[field.id] = field.defaultValue;
      } else if (field.type === 'boolean') {
        defaults[field.id] = false;
      } else if (field.type === 'tags') {
        defaults[field.id] = [];
      }
    }

    const newItem = addCollectionItem(collectionSlug, {
      ...defaults,
      _status: 'draft',
    });
    bumpVersion(v => v + 1);

    // Auto-expand the new item for editing
    setExpandedItemId(newItem._id);
  }, [collectionSlug, schema, bumpVersion]);

  const handleToggleItem = useCallback((itemId: string) => {
    trace.action('CmsOverlay:toggleItem', { itemId });
    setExpandedItemId(prev => prev === itemId ? null : itemId);
  }, []);

  const handleSaveItem = useCallback((updated: CollectionItem) => {
    if (!collectionSlug) return;
    trace.action('CmsOverlay:saveItem', { collectionSlug, itemId: updated._id });

    // Slug handling lives in ItemEditor (live title sync) + updateCollectionItem
    // (normalize + de-duplicate). Re-deriving here overwrote hand-typed slugs
    // and bypassed the uniqueness pass — see CmsEditorOverlay.handleSaveItem.
    const { _id, _createdAt, ...updates } = updated;
    updateCollectionItem(collectionSlug, updated._id, updates);
    bumpVersion(v => v + 1);
    // Deliberately does NOT collapse the row: ItemEditor now calls this on
    // every field blur (autosave), so collapsing here would close the editor
    // the moment the user tabbed from Title to Content. Collapse stays on the
    // row header / Cancel.
  }, [collectionSlug, bumpVersion]);

  const handleDeleteItem = useCallback((itemId: string) => {
    if (!collectionSlug) return;
    trace.action('CmsOverlay:deleteItem', { collectionSlug, itemId });
    removeCollectionItem(collectionSlug, itemId);
    bumpVersion(v => v + 1);
    if (expandedItemId === itemId) setExpandedItemId(null);
  }, [collectionSlug, expandedItemId, bumpVersion]);

  // ─── Render ───────────────────────────────────────────────────────────────

  trace.fn('CmsOverlay.render', {
    isOpen,
    collectionSlug,
    itemCount: items.length,
    filteredCount: filteredItems.length,
  });

  if (!isOpen || !collectionSlug) return null;

  const collectionName = schema?.name ?? collectionSlug;
  const fieldCount = schema?.fields.length ?? 0;

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50" onClick={handleClose} />

      {/* Content */}
      <div
        className="relative bg-[var(--bg-surface)] rounded-xl shadow-2xl border border-[var(--border-light)] flex flex-col"
        style={{ width: 1100, height: 750 }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── Header ─────────────────────────────────────────────────────── */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-[var(--border-light)] shrink-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-bold text-[var(--text-primary)]">
              Manage {collectionName}
            </span>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--grid-line)] text-[var(--text-disabled)] font-medium">
              {fieldCount} field{fieldCount !== 1 ? 's' : ''}
            </span>
          </div>
          <button
            onClick={handleClose}
            className="p-1 hover:bg-[var(--bg-hover)] rounded transition-colors text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* ── Toolbar Bar ────────────────────────────────────────────────── */}
        <div className="flex items-center gap-3 px-5 py-2.5 bg-[var(--bg-panel)] border-b border-[var(--border-light)] shrink-0">
          {/* Add Item */}
          <button
            onClick={handleAddItem}
            className="h-7 px-3 text-xs font-medium bg-[var(--accent)] text-[var(--accent-fg)] rounded-md hover:opacity-90 transition-opacity cursor-pointer flex items-center gap-1.5"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            Add Item
          </button>

          {/* Spacer */}
          <div className="flex-1" />

          {/* Item count */}
          <span className="text-xs text-[var(--text-disabled)]">
            {filteredItems.length}{filteredItems.length !== items.length ? ` / ${items.length}` : ''} item{items.length !== 1 ? 's' : ''}
          </span>

          {/* Search */}
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search items..."
            className="w-[200px] h-[var(--control-height-sm)] px-2.5 text-xs bg-[var(--bg-input)] border border-[var(--control-border)] rounded-md text-[var(--text-primary)] placeholder:text-[var(--text-disabled)] focus:outline-none focus:border-[var(--accent)]"
          />
        </div>

        {/* ── Content Area ───────────────────────────────────────────────── */}
        <div className="flex-1 overflow-y-auto">
          {filteredItems.length === 0 ? (
            <EmptyState hasSearch={!!searchQuery.trim()} query={searchQuery} />
          ) : (
            filteredItems.map(item => (
              <ItemRow
                key={item._id}
                item={item}
                schema={schema!}
                allItems={items}
                isExpanded={expandedItemId === item._id}
                onToggle={() => handleToggleItem(item._id)}
                onSave={handleSaveItem}
                onDelete={() => handleDeleteItem(item._id)}
              />
            ))
          )}
        </div>

        {/* ── Footer ─────────────────────────────────────────────────────── */}
        <div className="flex items-center justify-between px-5 py-3 border-t border-[var(--border-light)] bg-[var(--bg-panel)] shrink-0">
          <span className="text-xs text-[var(--text-disabled)]">
            {items.length} item{items.length !== 1 ? 's' : ''}
          </span>
          <button
            onClick={handleClose}
            className="h-8 px-5 text-xs font-medium bg-[var(--accent)] text-[var(--accent-fg)] rounded-lg hover:opacity-90 transition-opacity cursor-pointer"
          >
            Done
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
