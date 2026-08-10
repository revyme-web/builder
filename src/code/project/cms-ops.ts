// cms-ops.ts — CRUD operations for CMS collections in ProjectFS.
// Pure functions for reading/writing collection schema + data files.

import { projectFS } from './project-fs';
// AUTOSAVE lives on the three PERSIST points below (schema write, data write,
// delete) rather than on each caller.
//
// Autosave is normally driven by the mutation queue's `onAfterFlush`
// (useMutationQueueLifecycle) — but CMS writes never touch that queue. They go
// straight to projectFS, so nothing flushed and nothing scheduled a save: edit a
// collection, reload, and the work was gone (user report 2026-07-25). The MCP
// bridge already worked around this with its own `triggerAutosave({force:true})`
// after CMS commits; putting it at the source covers the CMS editor overlay, the
// Vibe agent and the plugin SDK too, without every call site remembering.
//
// UNFORCED, matching the code-edit path: the save-leader gate is deliberate, and
// a non-leader tab's write reaches the leader via file-sync. The MCP call sites
// keep their `force` — a bridge write must persist regardless of leader election.
// `triggerAutosave` is debounced, so a burst of field edits collapses into one save.
import { triggerAutosave } from '@/backend/autosave';
import { trace } from '@/shared/debug-trace';
import type { CollectionSchema, CollectionItem, FieldDefinition } from '@/shared/types';
import { parseJSXToNodes } from '@/code/parsing/parser';
import { removeNodeInCode } from '@/code/generation/generator-crud';
import { modifyProjectFile } from './modify-file';
import { parseCmsPageMeta } from './cms-page-meta';

// ─── Field type catalog ─────────────────────────────────────────────────────

/** All CMS field types with their human labels. Drives the field-type
 *  pickers (New Field menu, FieldSettings type select). */
export const FIELD_TYPES: { value: FieldDefinition['type']; label: string }[] = [
  { value: 'text', label: 'Text' },
  { value: 'textarea', label: 'Text Area' },
  { value: 'number', label: 'Number' },
  { value: 'boolean', label: 'Boolean' },
  { value: 'date', label: 'Date' },
  { value: 'image', label: 'Image' },
  { value: 'file', label: 'File' },
  { value: 'url', label: 'URL' },
  { value: 'link', label: 'Link' },
  { value: 'color', label: 'Color' },
  { value: 'enum', label: 'Enum' },
  { value: 'tags', label: 'Tags' },
  { value: 'slug', label: 'Slug' },
  { value: 'reference', label: 'Reference' },
  { value: 'multi-reference', label: 'Multi-Reference' },
];

// ─── ID Generation ──────────────────────────────────────────────────────────

let idCounter = 0;

/** Generate a unique item ID (timestamp + counter). */
export function generateItemId(): string {
  idCounter++;
  const id = `item_${Date.now().toString(36)}_${idCounter.toString(36)}`;
  trace.fn('cms-ops:generateItemId', { id });
  return id;
}

/** Convert text to a URL-safe slug. */
export function slugify(text: string): string {
  const slug = text
    .toString()
    .normalize('NFD')                   // decompose unicode
    .replace(/[\u0300-\u036f]/g, '')    // strip diacritics
    .toLowerCase()
    .trim()
    .replace(/_/g, '-')                 // underscores → hyphens
    .replace(/[^a-z0-9\s-]/g, '')      // remove non-alphanumeric
    .replace(/\s+/g, '-')              // spaces → hyphens
    .replace(/-+/g, '-')               // collapse multiple hyphens
    .replace(/^-|-$/g, '');            // trim leading/trailing hyphens
  trace.fn('cms-ops:slugify', { input: text, output: slug || 'untitled' });
  return slug || 'untitled';
}

/** Best display label for a collection item — its first text field's
 *  value, falling back to the slug, then 'Untitled'. Used by sidebar
 *  rows and the default-field picker. */
export function cmsItemLabel(item: CollectionItem, schema: CollectionSchema): string {
  const titleField = schema.fields.find(f => f.type === 'text');
  const raw = titleField ? item[titleField.id] : undefined;
  if (raw != null && String(raw).trim()) return String(raw);
  return item._slug ? `/${item._slug}` : 'Untitled';
}

// ─── Schema Operations ──────────────────────────────────────────────────────

/** List all collection slugs by scanning cms/*.schema.json files. */
export function listCollections(): string[] {
  const files = projectFS.listFiles('cms/');
  const slugs: string[] = [];
  for (const file of files) {
    const match = file.match(/^cms\/(.+)\.schema\.json$/);
    if (match) slugs.push(match[1]);
  }
  trace.fn('cms-ops:listCollections', { count: slugs.length, slugs });
  return slugs;
}

/** Read a collection schema by slug. Returns null if not found or malformed. */
export function getCollectionSchema(slug: string): CollectionSchema | null {
  const raw = projectFS.readFile(`cms/${slug}.schema.json`);
  if (!raw) {
    trace.fn('cms-ops:getCollectionSchema', { slug, found: false });
    return null;
  }
  try {
    const schema = JSON.parse(raw) as CollectionSchema;
    trace.fn('cms-ops:getCollectionSchema', { slug, found: true, fieldCount: schema.fields?.length ?? 0 });
    return schema;
  } catch (err) {
    trace.error('cms-ops:getCollectionSchema:parse-error', { slug, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/** Save a collection schema (creates or overwrites). */
export function saveCollectionSchema(slug: string, schema: CollectionSchema): void {
  projectFS.writeFile(`cms/${slug}.schema.json`, JSON.stringify(schema, null, 2));
  trace.action('cms-ops:saveCollectionSchema', { slug, fieldCount: schema.fields.length });
  triggerAutosave();
}

/** Delete a collection (removes both schema and data files). */
export function deleteCollection(slug: string): void {
  if (projectFS.exists(`cms/${slug}.schema.json`)) {
    projectFS.deleteFile(`cms/${slug}.schema.json`);
  }
  if (projectFS.exists(`cms/${slug}.json`)) {
    projectFS.deleteFile(`cms/${slug}.json`);
  }
  trace.action('cms-ops:deleteCollection', { slug });
  triggerAutosave();
}

// ─── Project-wide usage scan + cascade delete ───────────────────────────────

export interface CmsUsage {
  /** Bound elements: each `.map()` repeater in JSX whose `collectionList.source === slug`. */
  bindings: { filePath: string; nodeId: string }[];
  /** Detail page files (`@cmsPage { kind:'detail', collection:'<slug>' }`). */
  detailPages: string[];
  /** Number of items in the collection's data file (for the confirm prompt). */
  itemCount: number;
}

/**
 * Walk every page/component file in ProjectFS and report what depends on
 * `slug`. Used by the cascade-delete confirm dialog so the user sees the
 * full blast radius before clicking Delete.
 *
 * Cheap parser-driven scan: each file is parsed once, nodes with
 * `collectionList.source === slug` are recorded by `(filePath, nodeId)`,
 * and the file's `@cmsPage` annotation (if any) is checked for a matching
 * collection.
 */
export function scanCmsUsage(slug: string): CmsUsage {
  const bindings: { filePath: string; nodeId: string }[] = [];
  const detailPages: string[] = [];

  const files = [
    ...projectFS.listFiles('app/'),
    ...projectFS.listFiles('components/'),
  ].filter(p => p.endsWith('.tsx'));

  for (const filePath of files) {
    const code = projectFS.readFile(filePath);
    if (!code) continue;

    // Detail page check — uses the file's @cmsPage annotation, not parsing.
    const meta = parseCmsPageMeta(code);
    if (meta?.kind === 'detail' && meta.collection === slug) {
      detailPages.push(filePath);
    }

    // Bound element scan — parse and walk for collectionList.source === slug.
    let nodes: Map<string, any>;
    try {
      nodes = parseJSXToNodes(code);
    } catch (err) {
      trace.error('cms-ops:scanCmsUsage:parse-failed', { filePath, error: err instanceof Error ? err.message : String(err) });
      continue;
    }
    for (const [nodeId, node] of nodes) {
      if (node.collectionList?.source === slug) {
        bindings.push({ filePath, nodeId });
      }
    }
  }

  const itemCount = getCollectionData(slug).length;

  trace.fn('cms-ops:scanCmsUsage', {
    slug,
    bindingCount: bindings.length,
    detailPageCount: detailPages.length,
    itemCount,
  });

  return { bindings, detailPages, itemCount };
}

/**
 * Aggressive cascade delete: removes every `.map()` repeater bound to this
 * collection (the parent JSX node carrying `collectionList`), deletes the
 * detail-page files, then drops the schema + data files.
 *
 * Caller is expected to have surfaced the scan results to the user via a
 * confirm modal — this function does NOT prompt. There is no undo.
 *
 * Returns a summary of what was actually removed (mainly for logging /
 * showing a post-delete toast).
 */
export function cascadeDeleteCollection(slug: string): {
  removedBindings: number;
  removedDetailPages: number;
  removedItems: number;
} {
  const usage = scanCmsUsage(slug);
  trace.action('cms-ops:cascadeDeleteCollection:start', {
    slug,
    bindingCount: usage.bindings.length,
    detailPageCount: usage.detailPages.length,
    itemCount: usage.itemCount,
  });

  // Group bindings by file so we run one transform pass per file (cheaper +
  // avoids index-drift across multiple removals in the same file).
  const bindingsByFile = new Map<string, string[]>();
  for (const { filePath, nodeId } of usage.bindings) {
    const list = bindingsByFile.get(filePath) ?? [];
    list.push(nodeId);
    bindingsByFile.set(filePath, list);
  }

  for (const [filePath, nodeIds] of bindingsByFile) {
    modifyProjectFile(filePath, code => {
      let next = code;
      for (const nodeId of nodeIds) {
        next = removeNodeInCode(next, nodeId);
      }
      return next;
    });
  }

  for (const filePath of usage.detailPages) {
    // A detail page is a server + client pair — drop BOTH halves so the
    // server wrapper isn't left importing a deleted client body.
    const base = filePath.replace(/\/page(\.client)?\.tsx$/, '/page');
    for (const half of [`${base}.tsx`, `${base}.client.tsx`]) {
      if (projectFS.exists(half)) projectFS.deleteFile(half);
    }
  }

  // Schema + data last — once these are gone the bindings (now removed)
  // and detail pages (now deleted) have nothing to reference.
  deleteCollection(slug);

  trace.action('cms-ops:cascadeDeleteCollection:done', {
    slug,
    removedBindings: usage.bindings.length,
    removedDetailPages: usage.detailPages.length,
    removedItems: usage.itemCount,
  });

  return {
    removedBindings: usage.bindings.length,
    removedDetailPages: usage.detailPages.length,
    removedItems: usage.itemCount,
  };
}

/**
 * Map an item-values object's keys onto real schema field ids.
 *
 * The CMS agent sometimes keys values by a field's NAME or a camelCase
 * guess ("Body Content", "bodyContent") instead of its exact id
 * ("body-content"). This resolves any spelling that matches a field's id
 * OR name once case and separators are stripped. Meta keys (those starting
 * with "_", e.g. _status) pass straight through.
 *
 * Throws — listing the valid ids — when a key matches nothing, so the
 * caller (and the agent) sees the failure instead of silently writing a
 * dead key that updates nothing.
 */
export function resolveItemValues(
  schema: CollectionSchema,
  values: Record<string, any>,
): Record<string, any> {
  const compact = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const lookup = new Map<string, string>();
  for (const f of schema.fields) {
    lookup.set(compact(f.id), f.id);
    lookup.set(compact(f.name), f.id);
  }

  const out: Record<string, any> = {};
  const unknown: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (key.startsWith('_')) { out[key] = value; continue; }
    const fieldId = lookup.get(compact(key));
    if (fieldId) out[fieldId] = value;
    else unknown.push(key);
  }

  if (unknown.length > 0) {
    throw new Error(
      `Unknown field(s): ${unknown.join(', ')}. Valid field ids: ${
        schema.fields.map(f => f.id).join(', ') || '(none)'
      }.`,
    );
  }
  return out;
}

// ─── Data Operations ────────────────────────────────────────────────────────

/** Read all items for a collection. Returns empty array if no data file. */
export function getCollectionData(slug: string): CollectionItem[] {
  const raw = projectFS.readFile(`cms/${slug}.json`);
  if (!raw) {
    trace.fn('cms-ops:getCollectionData', { slug, found: false });
    return [];
  }
  try {
    const items = JSON.parse(raw) as CollectionItem[];
    trace.fn('cms-ops:getCollectionData', { slug, found: true, itemCount: items.length });
    return items;
  } catch (err) {
    trace.error('cms-ops:getCollectionData:parse-error', { slug, error: err instanceof Error ? err.message : String(err) });
    return [];
  }
}

/** Overwrite all items for a collection. */
export function saveCollectionData(slug: string, items: CollectionItem[]): void {
  projectFS.writeFile(`cms/${slug}.json`, JSON.stringify(items, null, 2));
  trace.action('cms-ops:saveCollectionData', { slug, itemCount: items.length });
  triggerAutosave();
}

/**
 * Read one item's translation for a field, or '' when untranslated.
 *
 * Translations live ON the item as `_i18n[locale][field]` — the same place the
 * published site reads them from via `localizeRows`, so authoring and rendering
 * can't diverge. (They used to live in `i18n/{locale}.json`, which nothing on
 * the deployed site could reach — that store is now migrated on load.)
 */
export function getCollectionItemTranslation(
  slug: string, itemId: string, locale: string, field: string,
): string {
  const raw = projectFS.readFile(`cms/${slug}.json`);
  if (!raw) return '';
  try {
    const items = JSON.parse(raw) as CollectionItem[];
    const v = items.find((i) => i._id === itemId)?._i18n?.[locale]?.[field];
    return typeof v === 'string' ? v : '';
  } catch { return ''; }
}

/**
 * Write one item's translation for a field.
 *
 * An EMPTY value CLEARS the translation (and prunes the now-empty locale /
 * `_i18n` containers) rather than storing '', so the row falls back to the
 * base language — the same "empty means not translated" rule `localizeRows`
 * applies at render.
 */
export function setCollectionItemTranslation(
  slug: string, itemId: string, locale: string, field: string, value: string,
): void {
  const raw = projectFS.readFile(`cms/${slug}.json`);
  if (!raw) return;
  let items: CollectionItem[];
  try { items = JSON.parse(raw) as CollectionItem[]; } catch { return; }
  const item = items.find((i) => i._id === itemId);
  if (!item) return;

  const i18n: Record<string, Record<string, string>> = { ...(item._i18n ?? {}) };
  const forLocale: Record<string, string> = { ...(i18n[locale] ?? {}) };
  if (value) forLocale[field] = value;
  else delete forLocale[field];

  if (Object.keys(forLocale).length > 0) i18n[locale] = forLocale;
  else delete i18n[locale];

  if (Object.keys(i18n).length > 0) item._i18n = i18n;
  else delete item._i18n;

  saveCollectionData(slug, items);
  trace.action('cms-ops:setCollectionItemTranslation', { slug, itemId, locale, field, cleared: !value });
}

// Per-session guard so the backfill scans each collection at most once.
const _backfilledSlugs = new Set<string>();

/** Backfill `_createdAt`/`_updatedAt` on any existing items that lack them (older
 *  data created before these system fields existed) so Created/Updated are usable
 *  as sort/filter values AND persist into the deployed cms/*.json. Idempotent —
 *  only writes a collection if something was actually missing; runs once per slug
 *  per session. New items already get timestamps via addCollectionItem. */
export function backfillCmsTimestamps(): void {
  const now = new Date().toISOString();
  for (const slug of listCollections()) {
    if (_backfilledSlugs.has(slug)) continue;
    _backfilledSlugs.add(slug);
    const items = getCollectionData(slug);
    let changed = false;
    const fixed = items.map(it => {
      if (it._createdAt && it._updatedAt) return it;
      changed = true;
      return { ...it, _createdAt: it._createdAt || now, _updatedAt: it._updatedAt || it._createdAt || now };
    });
    if (changed) {
      saveCollectionData(slug, fixed);
      trace.action('cms-ops:backfillCmsTimestamps', { slug, itemCount: fixed.length });
    }
  }
}

/** Strip a CSS `url('…')` / `url(…)` wrapper, returning the bare URL. Non-strings
 *  and unwrapped values pass through untouched. */
export function stripUrlWrapper(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const m = value.trim().match(/^url\(\s*(['"]?)([\s\S]*?)\1\s*\)$/i);
  return m ? m[2] : value;
}

/**
 * Normalize image/file field values to PLAIN URLs before they hit disk. CMS
 * image fields must store a bare URL — the renderer wraps `url(...)` only where
 * CSS needs it (`backgroundImage`), while `<img src>` and the field picker use
 * it raw; a stored `url('…')` double-wraps the background AND breaks the picker
 * (`<img src="url('…')">` fails to load → display:none). Catches every write
 * path (MCP add_item/update_item, AI, the field control). See the CMS_IMAGE_URL
 * oracle rule, which flags the same mistake in submitted collection JSON.
 */
function normalizeImageFieldValues(slug: string, values: Partial<CollectionItem>): Partial<CollectionItem> {
  const schema = getCollectionSchema(slug);
  if (!schema) return values;
  const imageFieldIds = schema.fields.filter(f => f.type === 'image' || f.type === 'file').map(f => f.id);
  if (imageFieldIds.length === 0) return values;
  let changed = false;
  const out = { ...values } as Record<string, any>;
  for (const id of imageFieldIds) {
    if (id in out) {
      const stripped = stripUrlWrapper(out[id]);
      if (stripped !== out[id]) { out[id] = stripped; changed = true; }
    }
  }
  if (changed) trace.action('cms-ops:normalize-image-fields', { slug, fields: imageFieldIds });
  return out as Partial<CollectionItem>;
}

/** Make `base` unique among the collection's existing item slugs by appending
 *  `-2`, `-3`, … (skips `excludeId`'s own slug so re-deriving an item's slug
 *  doesn't suffix against itself). Prevents the 3-way `_slug:"item"` collision
 *  that left every detail route pointing at the same record. */
export function uniqueItemSlug(items: CollectionItem[], base: string, excludeId?: string): string {
  const taken = new Set(items.filter(i => i._id !== excludeId).map(i => i._slug));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/** True when `currentSlug` is still AUTO-DERIVED from the title (so updating the
 *  title should re-derive it) rather than a slug the user typed by hand. Matches
 *  the empty-creation fallback (`item` / `item-N`), an empty slug, and any slug
 *  that equals `slugify(oldTitle)` or `slugify(oldTitle)-N`. A hand-edited slug
 *  matches none of these → it's preserved (existing links don't break).
 *
 *  Exported so the item editor can seed the same "is the slug still linked to
 *  the title?" decision when it opens — the live typing preview and the save
 *  path must agree, or the field would visibly change value on save. */
export function isAutoDerivedSlug(currentSlug: string, oldTitle: string): boolean {
  if (!currentSlug) return true;
  if (/^item(-\d+)?$/.test(currentSlug)) return true;
  const base = oldTitle ? slugify(oldTitle) : '';
  if (!base) return false;
  return currentSlug === base || new RegExp(`^${base}-\\d+$`).test(currentSlug);
}

/** Add a new item to a collection. Auto-generates _id, _slug, timestamps. */
export function addCollectionItem(slug: string, item: Partial<CollectionItem>): CollectionItem {
  const items = getCollectionData(slug);
  const schema = getCollectionSchema(slug);
  item = normalizeImageFieldValues(slug, item);

  // Slug source priority: explicit `item._slug` → first text field value →
  // 'item' fallback. Always slugified + uniquified so two empty/identically-
  // named items don't collide (the old code let 3 empty items all become
  // `_slug:"item"`, so every detail route resolved to one record).
  const firstTextField = schema?.fields.find(f => f.type === 'text');
  const slugSource = item._slug
    ? String(item._slug)
    : (firstTextField && item[firstTextField.id]) ? String(item[firstTextField.id]) : 'item';
  const finalSlug = uniqueItemSlug(items, slugify(slugSource));

  // Schema defaults seed a new item HERE, not in the caller — every creation path (the CMS
  // panel, the MCP agent, a duplicate) has to agree, and only the panel used to apply them,
  // so an MCP-created item silently came out with no defaults at all. Caller-supplied values
  // spread AFTER these, so an explicit value always wins.
  const defaults: Record<string, unknown> = {};
  for (const f of schema?.fields ?? []) {
    if (f.defaultValue !== undefined) defaults[f.id] = f.defaultValue;
    else if (f.type === 'boolean') defaults[f.id] = false;
    else if (f.type === 'tags') defaults[f.id] = [];
  }

  const now = new Date().toISOString();
  const newItem: CollectionItem = {
    _status: 'published',
    ...defaults,
    ...item,
    _id: generateItemId(),  // always generated, never from spread
    _slug: finalSlug,       // AFTER spread so a raw item._slug can't leak through un-normalized
    _createdAt: now,
    _updatedAt: now,
  };

  items.push(newItem);
  saveCollectionData(slug, items);
  trace.action('cms-ops:addCollectionItem', { slug, itemId: newItem._id, itemSlug: newItem._slug });
  return newItem;
}

/** Update fields on an existing item. Automatically bumps _updatedAt. */
export function updateCollectionItem(slug: string, itemId: string, updates: Partial<CollectionItem>): void {
  const items = getCollectionData(slug);
  const idx = items.findIndex(i => i._id === itemId);
  if (idx < 0) {
    trace.error('cms-ops:updateCollectionItem:not-found', { slug, itemId });
    return;
  }
  updates = normalizeImageFieldValues(slug, updates);

  // Auto-sync `_slug` to the title (first text field) WHILE the slug is still
  // auto-derived — fixes items created empty (`_slug:"item"`) then named later,
  // which previously kept the placeholder slug forever (3-way collision → every
  // detail route resolved to one record). A hand-typed slug is preserved, and an
  // explicit `_slug` in this update always wins.
  const schema = getCollectionSchema(slug);
  const firstTextField = schema?.fields.find(f => f.type === 'text');
  if (firstTextField && updates[firstTextField.id] !== undefined && !('_slug' in updates)) {
    const prev = items[idx];
    const oldTitle = prev[firstTextField.id] != null ? String(prev[firstTextField.id]) : '';
    if (isAutoDerivedSlug(String(prev._slug ?? ''), oldTitle)) {
      const newTitle = String(updates[firstTextField.id] ?? '');
      const base = newTitle ? slugify(newTitle) : 'item';
      updates = { ...updates, _slug: uniqueItemSlug(items, base, itemId) };
    }
  } else if ('_slug' in updates) {
    // EXPLICIT slug (item editor, CmsPanel's slug row, MCP, the AI agent).
    // Normalize + uniquify it too: a slug is a URL key, so two items in one
    // collection sharing it makes one detail route unreachable. Only the
    // derived branch above used to do this, so anything that passed `_slug`
    // straight through could collide (user report 2026-07-25). An emptied
    // slug falls back to the current title, then the `item` placeholder.
    const prev = items[idx];
    const title = firstTextField
      ? String(updates[firstTextField.id] ?? prev[firstTextField.id] ?? '')
      : '';
    const raw = String(updates._slug ?? '').trim() || title || 'item';
    updates = { ...updates, _slug: uniqueItemSlug(items, slugify(raw), itemId) };
  }

  items[idx] = { ...items[idx], ...updates, _updatedAt: new Date().toISOString() };
  saveCollectionData(slug, items);
  trace.action('cms-ops:updateCollectionItem', { slug, itemId, updatedFields: Object.keys(updates), slugSynced: '_slug' in updates });
}

/** Remove an item from a collection by ID. */
export function removeCollectionItem(slug: string, itemId: string): void {
  const items = getCollectionData(slug);
  const before = items.length;
  const filtered = items.filter(i => i._id !== itemId);
  if (filtered.length === before) {
    trace.error('cms-ops:removeCollectionItem:not-found', { slug, itemId });
    return;
  }
  saveCollectionData(slug, filtered);
  trace.action('cms-ops:removeCollectionItem', { slug, itemId, remainingCount: filtered.length });
}

/** Reorder a collection's items to match `orderedIds`. The stored array order IS
 *  the order a collection-list `.map()` renders, so this is the single source of
 *  truth for item order. Defensive: items whose ids aren't in `orderedIds` (a
 *  stale/partial list) are appended in their existing order so nothing is dropped,
 *  and an unchanged order is a no-op (no needless write / version bump). */
export function reorderCollectionItems(slug: string, orderedIds: string[]): void {
  const items = getCollectionData(slug);
  const byId = new Map(items.map(i => [i._id, i]));
  const seen = new Set<string>();
  const reordered: CollectionItem[] = [];
  for (const id of orderedIds) {
    const it = byId.get(id);
    if (it && !seen.has(id)) { reordered.push(it); seen.add(id); }
  }
  for (const it of items) {
    if (!seen.has(it._id)) reordered.push(it);
  }
  const unchanged = reordered.length === items.length && reordered.every((it, i) => it._id === items[i]._id);
  if (unchanged) {
    trace.fn('cms-ops:reorderCollectionItems:no-op', { slug });
    return;
  }
  saveCollectionData(slug, reordered);
  trace.action('cms-ops:reorderCollectionItems', { slug, count: reordered.length });
}

// ─── Collection-level operations ────────────────────────────────────────────

/** Rename a collection's display name. The slug (file key) is left
 *  unchanged — renaming it would mean moving files and rewriting every
 *  binding that references it. */
export function renameCollection(slug: string, name: string): void {
  const schema = getCollectionSchema(slug);
  if (!schema) {
    trace.error('cms-ops:renameCollection:not-found', { slug });
    return;
  }
  saveCollectionSchema(slug, { ...schema, name });
  trace.action('cms-ops:renameCollection', { slug, name });
}

/** Create a collection with a single default Title field. With no `name`
 *  it is auto-named "Collection N" (one past the highest existing
 *  "Collection <number>", so the number is stable even with gaps) — the
 *  inline "+ add collection" flow. With an explicit `name` (the CMS
 *  agent's create_collection tool) that name is used verbatim. Returns
 *  the new slug. */
export function createBlankCollection(name?: string): string {
  let displayName = name?.trim();
  if (!displayName) {
    // Auto-name: scan existing names for "Collection N", take max + 1.
    let maxN = 0;
    for (const s of listCollections()) {
      const m = getCollectionSchema(s)?.name.match(/^Collection (\d+)$/);
      if (m) maxN = Math.max(maxN, parseInt(m[1], 10));
    }
    displayName = `Collection ${maxN + 1}`;
  }

  // Slug derived from the name; uniquified in case the slug is taken.
  const existing = new Set(listCollections());
  const base = slugify(displayName);
  let slug = base;
  let n = 2;
  while (existing.has(slug)) { slug = `${base}-${n}`; n++; }

  saveCollectionSchema(slug, {
    name: displayName,
    slug,
    fields: [{ id: 'title', name: 'Title', type: 'text', required: true }],
  });
  trace.action('cms-ops:createBlankCollection', { slug, name: displayName });
  return slug;
}

// ─── Field (schema) operations ──────────────────────────────────────────────

/** A JS-identifier-safe field id derived from a field name. camelCase (no
 *  hyphens) so generated pages can use `item.fieldId` dot access — a
 *  hyphenated id like `cover-image` would parse as `item.cover - image`.
 *    "Cover Image" → "coverImage"   "Title" → "title"
 *    "2024 Recap"  → "field2024Recap"  (can't start with a digit) */
function fieldIdFromName(name: string): string {
  const camel = slugify(name).replace(/-+([a-z0-9])/g, (_, c: string) => c.toUpperCase());
  if (!camel) return 'field';
  return /^[0-9]/.test(camel) ? `field${camel}` : camel;
}

/**
 * A field name that doesn't collide with any already used in the collection.
 *
 * `"Content"` when `Content` exists → `"Content 2"`, then `"Content 3"`, … The
 * field ID has always been uniquified (`content`, `content2`) but the NAME was
 * not, so a collection could hold two fields both displayed as "Content" —
 * indistinguishable in the fields list, the binding pickers and the item editor
 * (user report 2026-07-25). Matches the reference CMS's behaviour.
 *
 * Comparison is trimmed + case-insensitive: "content" and "Content" collapse to
 * the same ID anyway, so treating them as distinct names would just reproduce the
 * bug in a different casing. A typed `"Title 2"` that's already taken continues
 * from the base — `"Title 3"`, not `"Title 2 2"`. A BLANK name is returned as-is:
 * new fields start unnamed and the UI shows them as "Untitled field".
 */
export function uniqueFieldName(desired: string, taken: readonly string[]): string {
  const name = desired.trim();
  if (!name) return desired;
  const norm = (s: string) => s.trim().toLowerCase();
  const used = new Set(taken.map(norm));
  if (!used.has(norm(name))) return name;
  const base = name.replace(/\s+\d+$/, '').trim() || name;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base} ${n}`;
    if (!used.has(norm(candidate))) return candidate;
  }
  return name;
}

/** Is an item's stored value "unset" for default purposes? `false` and `0` are REAL values a
 *  user chose (a boolean field defaulting true, a number defaulting 10), so only absent and
 *  empty-string count. An empty array is unset for the array-valued types (tags/multi-ref). */
function isUnsetValue(v: unknown): boolean {
  return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
}

const sameValue = (a: unknown, b: unknown): boolean =>
  a === b || (a !== undefined && b !== undefined && JSON.stringify(a) === JSON.stringify(b));

/**
 * Push a field's `defaultValue` down onto the collection's ITEMS, and return how many changed.
 *
 * A default that lives only in the schema is invisible everywhere it matters: the published page
 * imports `cms/<slug>.json` DIRECTLY (`import projects from '@/cms/projects.json'`), so nothing
 * resolves schema defaults at render time — an item with no key renders empty on the live site no
 * matter what the schema says. Defaults were therefore only ever applied at item-CREATION time
 * (CmsOverlay.handleAddItem), which means items that predate the field never got one and editing a
 * default never reached any item at all (live find 2026-07-30: a Color field defaulted to #000000
 * showed as placeholder-only on all six existing items).
 *
 * "Synced until I change it individually" is preserved by migrating on the OLD default: an item
 * still holding `prevDefault` is following the field, so it follows to `nextDefault`; an item
 * holding anything else was set by hand and is left alone. Unset items always take the default.
 */
export function syncFieldDefaultToItems(
  slug: string,
  fieldId: string,
  nextDefault: unknown,
  prevDefault?: unknown,
): number {
  if (nextDefault === undefined) return 0;   // clearing a default never rewrites item data
  const items = getCollectionData(slug);
  let changed = 0;
  const next = items.map((item) => {
    const current = (item as Record<string, unknown>)[fieldId];
    const follows = isUnsetValue(current)
      || (prevDefault !== undefined && sameValue(current, prevDefault));
    if (!follows || sameValue(current, nextDefault)) return item;
    changed++;
    return { ...item, [fieldId]: nextDefault };
  });
  if (changed) saveCollectionData(slug, next);
  trace.action('cms-ops:syncFieldDefaultToItems', { slug, fieldId, changed, total: items.length });
  return changed;
}

/** Append a field to a collection's schema. Returns the generated field
 *  id (derived from the name, uniquified), or null if the collection is
 *  missing. */
export function addCollectionField(
  slug: string,
  field: {
    name: string;
    type: FieldDefinition['type'];
    required?: boolean;
    options?: string[];
    referenceCollection?: string;
    defaultValue?: unknown;
  },
): string | null {
  const schema = getCollectionSchema(slug);
  if (!schema) {
    trace.error('cms-ops:addCollectionField:not-found', { slug });
    return null;
  }
  // Uniquify the NAME first, then derive the id from it, so the two stay in
  // step ("Content 2" → `content2`). The id loop below stays as a safety net.
  const name = uniqueFieldName(field.name, schema.fields.map(f => f.name));
  const existingIds = new Set(schema.fields.map(f => f.id));
  const base = fieldIdFromName(name);
  let id = base;
  let n = 2;
  // Suffix without a hyphen so the id stays a valid JS identifier.
  while (existingIds.has(id)) { id = `${base}${n}`; n++; }

  const newField: FieldDefinition = { id, name, type: field.type };
  if (field.required) newField.required = true;
  if (field.options) newField.options = field.options;
  if (field.referenceCollection) newField.referenceCollection = field.referenceCollection;
  if (field.defaultValue !== undefined) newField.defaultValue = field.defaultValue;

  saveCollectionSchema(slug, { ...schema, fields: [...schema.fields, newField] });
  // A field born with a default applies to the items that already exist, not just to ones
  // created afterwards — otherwise the default is invisible on every current row.
  if (newField.defaultValue !== undefined) syncFieldDefaultToItems(slug, id, newField.defaultValue);
  trace.action('cms-ops:addCollectionField', { slug, id, type: field.type });
  return id;
}

/** Patch an existing field. Returns false if the collection or field is
 *  missing. */
export function updateCollectionField(
  slug: string,
  fieldId: string,
  patch: Partial<FieldDefinition>,
): boolean {
  const schema = getCollectionSchema(slug);
  const prevField = schema?.fields.find(f => f.id === fieldId);
  if (!schema || !prevField) {
    trace.error('cms-ops:updateCollectionField:not-found', { slug, fieldId });
    return false;
  }
  // A RENAME must not collide either — uniquify against the OTHER fields (the
  // field keeps its own name, so re-committing an unchanged name is a no-op).
  let applied = patch;
  if (typeof patch.name === 'string') {
    const others = schema.fields.filter(f => f.id !== fieldId).map(f => f.name);
    const name = uniqueFieldName(patch.name, others);
    if (name !== patch.name) {
      trace.action('cms-ops:updateCollectionField:name-deduped', { slug, fieldId, from: patch.name, to: name });
    }
    applied = { ...patch, name };
  }
  saveCollectionSchema(slug, {
    ...schema,
    fields: schema.fields.map(f => (f.id === fieldId ? { ...f, ...applied } : f)),
  });
  // Editing the default cascades to every item that is still FOLLOWING it (unset, or still
  // holding the previous default). Hand-edited items keep their value — that's what makes the
  // default feel "linked until you override it" rather than a one-shot seed at creation.
  if ('defaultValue' in applied) {
    syncFieldDefaultToItems(slug, fieldId, applied.defaultValue, prevField.defaultValue);
  }
  trace.action('cms-ops:updateCollectionField', { slug, fieldId });
  return true;
}

/** Remove a field from a collection's schema. Returns false if the
 *  collection or field is missing. */
export function removeCollectionField(slug: string, fieldId: string): boolean {
  const schema = getCollectionSchema(slug);
  if (!schema) {
    trace.error('cms-ops:removeCollectionField:not-found', { slug, fieldId });
    return false;
  }
  const next = schema.fields.filter(f => f.id !== fieldId);
  if (next.length === schema.fields.length) {
    trace.error('cms-ops:removeCollectionField:no-such-field', { slug, fieldId });
    return false;
  }
  saveCollectionSchema(slug, { ...schema, fields: next });
  trace.action('cms-ops:removeCollectionField', { slug, fieldId });
  return true;
}

/** Duplicate a collection — copies the schema (new display name + a
 *  unique slug) and every item. Returns the new slug, or null when the
 *  source collection is missing. */
export function duplicateCollection(slug: string): string | null {
  const schema = getCollectionSchema(slug);
  if (!schema) {
    trace.error('cms-ops:duplicateCollection:not-found', { slug });
    return null;
  }

  const newName = `${schema.name} copy`;
  // The slug is the file key, so it must be unique — append -2, -3, …
  // on collision.
  const existing = new Set(listCollections());
  const base = slugify(newName);
  let newSlug = base;
  let n = 2;
  while (existing.has(newSlug)) { newSlug = `${base}-${n}`; n++; }

  saveCollectionSchema(newSlug, { ...schema, name: newName, slug: newSlug });
  const items = getCollectionData(slug);
  if (items.length > 0) saveCollectionData(newSlug, items);

  trace.action('cms-ops:duplicateCollection', { from: slug, to: newSlug, itemCount: items.length });
  return newSlug;
}
