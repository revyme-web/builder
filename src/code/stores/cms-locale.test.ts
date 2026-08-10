// cms-locale.test.ts — CMS field translations merged over the base rows.
//
// Manage Translations has always WRITTEN this shape — `collections[slug]
// [itemId][field]` in `i18n/{locale}.json` — and nothing read it, so a user
// could translate a collection, watch it save, and see English on the canvas
// and on the published site (user report 2026-08-10, reproduced end to end).
//
// The model is one row with a translation per field, NOT one row per language.

import { describe, it, expect } from 'vitest';
import { localizeCollectionRows, localizeCollections } from './cms-locale';
import type { CollectionItem } from '@/shared/types';

const row = (id: string, i18n?: Record<string, Record<string, unknown>>): CollectionItem =>
  ({ _id: id, _slug: id, _status: 'published', _createdAt: '', _updatedAt: '',
     title: `${id} title`, body: `${id} body`, ...(i18n ? { _i18n: i18n } : {}) }) as CollectionItem;

/** `a` is translated into French, `b` is not — the normal half-done state. */
const ROWS = [row('a', { fr: { title: 'titre a' } }), row('b')];

describe('localizeCollectionRows', () => {
  it('replaces a translated field', () => {
    expect(localizeCollectionRows(ROWS, 'fr')[0].title).toBe('titre a');
  });

  it('leaves the row’s OTHER fields alone', () => {
    // Half-translated is the normal state; an untranslated field falls back to
    // the base language rather than blanking, like every other locale fallback.
    expect(localizeCollectionRows(ROWS, 'fr')[0].body).toBe('a body');
  });

  it('leaves untranslated ROWS alone', () => {
    const out = localizeCollectionRows(ROWS, 'fr');
    expect(out[1]).toBe(ROWS[1]);          // same object, not a copy
    expect(out[1].title).toBe('b title');
  });

  it('never changes the row COUNT — that is the whole point', () => {
    // The workaround this replaces duplicated rows per language and filtered
    // them down. One row, N translations.
    expect(localizeCollectionRows(ROWS, 'fr')).toHaveLength(2);
  });

  it('preserves _id so bindings, keys and row identity survive', () => {
    const out = localizeCollectionRows(ROWS, 'fr');
    expect(out[0]._id).toBe('a');
    expect(out[0]._slug).toBe('a');
  });

  it('treats an EMPTY translation as "not translated"', () => {
    // The overlay writes '' to clear a translation. Taking that literally
    // would erase the row's text instead of falling back.
    const cleared = [row('a', { fr: { title: '' } })];
    const out = localizeCollectionRows(cleared, 'fr');
    expect(out[0].title).toBe('a title');
    expect(out[0]).toBe(cleared[0]);
  });

  it('returns the SAME array when nothing applies', () => {
    // Identity matters: this runs on every project version bump, and a fresh
    // array would re-render every subscriber on every commit.
    expect(localizeCollectionRows(ROWS, undefined)).toBe(ROWS);   // no locale
    expect(localizeCollectionRows(ROWS, 'de')).toBe(ROWS);        // locale with no translations
  });
});

describe('localizeCollections', () => {
  const DATA = new Map([['programs', ROWS], ['other', [row('c')]]]);

  it('localizes each collection', () => {
    expect(localizeCollections(DATA, 'fr').get('programs')![0].title).toBe('titre a');
  });

  it('leaves collections with no translations untouched', () => {
    expect(localizeCollections(DATA, 'fr').get('other')).toBe(DATA.get('other'));
  });

  it('returns the SAME Map when nothing applies', () => {
    expect(localizeCollections(DATA, undefined)).toBe(DATA);
    expect(localizeCollections(DATA, 'de')).toBe(DATA);
  });
});
