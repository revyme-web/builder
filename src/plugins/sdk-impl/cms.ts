// plugins/sdk-impl/cms.ts — cms.* namespace.
//
// Wires the full CRUD surface for CMS collections and items via the
// existing `cms-ops` module. Managed-collection methods (Plugin-
// controlled collections) map onto the same store with a `managedBy`
// metadata field — when the user installs a plugin that creates a
// managed collection, that plugin's id goes there. Plugins
// querying `getManagedCollections()` see only collections their
// own plugin id manages.

import { getDefaultStore } from 'jotai';
import { projectFS, projectVersionAtom } from '@/code/project/project-fs';
import {
  listCollections,
  getCollectionSchema,
  saveCollectionSchema,
  getCollectionData,
  saveCollectionData,
  addCollectionItem,
  updateCollectionItem,
  removeCollectionItem,
  generateItemId,
  slugify,
} from '@/code/project/cms-ops';
import type {
  Collection,
  CollectionField,
  CollectionItem as PluginCollectionItem,
} from '@revyme/plugin-sdk';
import type { CollectionSchema, FieldDefinition, CollectionItem } from '@/shared/types';
import type { RpcHandler } from '../plugin-types';

const store = getDefaultStore();

/** Where we persist the plugin → collection ownership map. */
const MANAGED_INDEX_PATH = '_meta/cms-managed-by.json';

function readManagedIndex(): Record<string, string> {
  const raw = projectFS.readFile(MANAGED_INDEX_PATH);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed ? parsed : {};
  } catch {
    return {};
  }
}

function writeManagedIndex(idx: Record<string, string>): void {
  projectFS.writeFile(MANAGED_INDEX_PATH, JSON.stringify(idx, null, 2));
  store.set(projectVersionAtom, (v) => v + 1);
}

function schemaToCollection(schema: CollectionSchema, managedBy: string | null): Collection {
  return {
    id: schema.slug,
    name: schema.name,
    managedBy,
    readonly: false,
    slugFieldName: '_slug',
  };
}

function fieldDefToField(f: FieldDefinition): CollectionField {
  // Map Revyme's richer field types onto the public SDK's narrower
  // set. Anything not in the SDK enum buckets to 'string'.
  const mapType = (t: FieldDefinition['type']): CollectionField['type'] => {
    switch (t) {
      case 'number': return 'number';
      case 'boolean': return 'boolean';
      case 'date': return 'date';
      case 'image': return 'image';
      case 'file': return 'file';
      case 'enum': return 'enum';
      case 'reference': case 'multi-reference': return 'reference';
      default: return 'string';
    }
  };
  return { id: f.id, name: f.name, type: mapType(f.type), required: f.required };
}

function itemToCollectionItem(item: CollectionItem): PluginCollectionItem {
  // Strip Revyme's underscore-prefixed metadata fields; the public
  // shape exposes `id` + `slug` explicitly + `fieldData` for the rest.
  const { _id, _slug, _status, _layout, _publishAt, _createdAt, _updatedAt, ...rest } = item;
  void _status; void _layout; void _publishAt; void _createdAt; void _updatedAt;
  return { id: _id, slug: _slug, fieldData: rest };
}

export const cmsHandlers: Record<string, RpcHandler> = {
  'cms.getCollections': async (): Promise<Collection[]> => {
    const idx = readManagedIndex();
    return listCollections().map((slug) => {
      const schema = getCollectionSchema(slug);
      if (!schema) return null;
      return schemaToCollection(schema, idx[slug] ?? null);
    }).filter((x): x is Collection => x !== null);
  },

  'cms.getActiveCollection': async (): Promise<Collection | null> => {
    // No "active CMS collection" atom in Revyme yet — derive
    // from URL slug when on a CMS page. Future: read a dedicated
    // atom written by the CMS panel UI.
    return null;
  },

  'cms.getActiveManagedCollection': async (_params, ctx): Promise<Collection | null> => {
    const idx = readManagedIndex();
    for (const [slug, ownerId] of Object.entries(idx)) {
      if (ownerId === ctx.manifest.id) {
        const schema = getCollectionSchema(slug);
        if (schema) return schemaToCollection(schema, ownerId);
      }
    }
    return null;
  },

  'cms.getManagedCollections': async (_params, ctx): Promise<Collection[]> => {
    const idx = readManagedIndex();
    const out: Collection[] = [];
    for (const [slug, ownerId] of Object.entries(idx)) {
      if (ownerId !== ctx.manifest.id) continue;
      const schema = getCollectionSchema(slug);
      if (schema) out.push(schemaToCollection(schema, ownerId));
    }
    return out;
  },

  'cms.createCollection': async (params): Promise<string> => {
    const p = params as { name?: unknown };
    if (typeof p?.name !== 'string') throw new Error('cms.createCollection: name required');
    const slug = slugify(p.name);
    const schema: CollectionSchema = { name: p.name, slug, fields: [] };
    saveCollectionSchema(slug, schema);
    return slug;
  },

  'cms.createManagedCollection': async (params, ctx): Promise<string> => {
    const p = params as { name?: unknown };
    if (typeof p?.name !== 'string') throw new Error('cms.createManagedCollection: name required');
    const slug = slugify(p.name);
    saveCollectionSchema(slug, { name: p.name, slug, fields: [] });
    const idx = readManagedIndex();
    idx[slug] = ctx.manifest.id;
    writeManagedIndex(idx);
    return slug;
  },

  'cms.getFields': async (params): Promise<CollectionField[]> => {
    const p = params as { collectionId?: unknown };
    if (typeof p?.collectionId !== 'string') throw new Error('cms.getFields: collectionId required');
    const schema = getCollectionSchema(p.collectionId);
    return (schema?.fields ?? []).map(fieldDefToField);
  },

  'cms.addFields': async (params): Promise<string[]> => {
    const p = params as { collectionId?: unknown; fields?: unknown };
    if (typeof p?.collectionId !== 'string' || !Array.isArray(p?.fields)) {
      throw new Error('cms.addFields: collectionId + fields[] required');
    }
    const schema = getCollectionSchema(p.collectionId);
    if (!schema) throw new Error(`cms.addFields: collection not found: ${p.collectionId}`);
    const ids: string[] = [];
    for (const f of p.fields) {
      if (!f || typeof f !== 'object') continue;
      const ff = f as { name: string; type: string; required?: boolean };
      const id = slugify(ff.name);
      schema.fields.push({
        id,
        name: ff.name,
        type: ff.type as FieldDefinition['type'],
        required: ff.required,
      });
      ids.push(id);
    }
    saveCollectionSchema(p.collectionId, schema);
    return ids;
  },

  'cms.removeFields': async (params): Promise<void> => {
    const p = params as { collectionId?: unknown; fieldIds?: unknown };
    if (typeof p?.collectionId !== 'string' || !Array.isArray(p?.fieldIds)) {
      throw new Error('cms.removeFields: collectionId + fieldIds[] required');
    }
    const schema = getCollectionSchema(p.collectionId);
    if (!schema) return;
    const drop = new Set(p.fieldIds as string[]);
    schema.fields = schema.fields.filter((f) => !drop.has(f.id));
    saveCollectionSchema(p.collectionId, schema);
  },

  'cms.setFieldOrder': async (params): Promise<void> => {
    const p = params as { collectionId?: unknown; fieldIds?: unknown };
    if (typeof p?.collectionId !== 'string' || !Array.isArray(p?.fieldIds)) {
      throw new Error('cms.setFieldOrder: collectionId + fieldIds[] required');
    }
    const schema = getCollectionSchema(p.collectionId);
    if (!schema) return;
    const indexMap = new Map<string, number>();
    (p.fieldIds as string[]).forEach((id, i) => indexMap.set(id, i));
    schema.fields.sort((a, b) => (indexMap.get(a.id) ?? 999) - (indexMap.get(b.id) ?? 999));
    saveCollectionSchema(p.collectionId, schema);
  },

  'cms.getItems': async (params): Promise<PluginCollectionItem[]> => {
    const p = params as { collectionId?: unknown };
    if (typeof p?.collectionId !== 'string') throw new Error('cms.getItems: collectionId required');
    return getCollectionData(p.collectionId).map(itemToCollectionItem);
  },

  'cms.addItems': async (params): Promise<string[]> => {
    const p = params as { collectionId?: unknown; items?: unknown };
    if (typeof p?.collectionId !== 'string' || !Array.isArray(p?.items)) {
      throw new Error('cms.addItems: collectionId + items[] required');
    }
    const ids: string[] = [];
    for (const item of p.items) {
      if (!item || typeof item !== 'object') continue;
      const ii = item as { slug: string; fieldData: Record<string, unknown> };
      const partial: Partial<CollectionItem> = {
        _id: generateItemId(),
        _slug: ii.slug,
        _status: 'published',
        ...ii.fieldData,
      };
      const created = addCollectionItem(p.collectionId, partial);
      ids.push(created._id);
    }
    return ids;
  },

  'cms.removeItems': async (params): Promise<void> => {
    const p = params as { collectionId?: unknown; itemIds?: unknown };
    if (typeof p?.collectionId !== 'string' || !Array.isArray(p?.itemIds)) {
      throw new Error('cms.removeItems: collectionId + itemIds[] required');
    }
    for (const id of p.itemIds as string[]) {
      removeCollectionItem(p.collectionId, id);
    }
  },

  'cms.setItemOrder': async (params): Promise<void> => {
    const p = params as { collectionId?: unknown; itemIds?: unknown };
    if (typeof p?.collectionId !== 'string' || !Array.isArray(p?.itemIds)) {
      throw new Error('cms.setItemOrder: collectionId + itemIds[] required');
    }
    const items = getCollectionData(p.collectionId);
    const order = new Map<string, number>();
    (p.itemIds as string[]).forEach((id, i) => order.set(id, i));
    items.sort((a, b) => (order.get(a._id) ?? 999) - (order.get(b._id) ?? 999));
    saveCollectionData(p.collectionId, items);
  },
};

// `updateCollectionItem` is reserved for a future `cms.updateItem`
// method (not currently typed in the public SDK; deferred to
// when item-level edits prove needed).
void updateCollectionItem;
