// cms-store.ts — Jotai atoms for CMS Collections state.
// Schema + data atoms are DERIVED from ProjectFS — auto-update on version bump (undo/redo).

import { atom } from 'jotai';
import { projectFS, projectVersionAtom } from '../project/project-fs';
import type { CollectionSchema, CollectionItem } from '@/shared/types';

// All collection schemas, keyed by slug — derived from ProjectFS
export const collectionSchemasAtom = atom<Map<string, CollectionSchema>>((get) => {
  get(projectVersionAtom);
  const schemas = new Map<string, CollectionSchema>();
  const files = projectFS.listFiles('cms/');
  for (const f of files) {
    if (!f.endsWith('.schema.json')) continue;
    const slug = f.replace('cms/', '').replace('.schema.json', '');
    const raw = projectFS.readFile(f);
    if (raw) {
      try { schemas.set(slug, JSON.parse(raw)); } catch { /* skip corrupt */ }
    }
  }
  return schemas;
});

// All collection data, keyed by slug — derived from ProjectFS
export const collectionDataAtom = atom<Map<string, CollectionItem[]>>((get) => {
  get(projectVersionAtom);
  const data = new Map<string, CollectionItem[]>();
  const files = projectFS.listFiles('cms/');
  for (const f of files) {
    if (!f.endsWith('.json') || f.endsWith('.schema.json')) continue;
    const slug = f.replace('cms/', '').replace('.json', '');
    const raw = projectFS.readFile(f);
    if (raw) {
      try { data.set(slug, JSON.parse(raw)); } catch { /* skip corrupt */ }
    }
  }
  return data;
});

// Currently selected collection in CMS panel
export const activeCmsCollectionAtom = atom<string | null>(null);

// Currently editing item ID
export const editingCmsItemAtom = atom<string | null>(null);
