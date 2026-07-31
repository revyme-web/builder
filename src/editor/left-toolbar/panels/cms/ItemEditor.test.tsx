// ItemEditor.test.tsx — slug↔title sync and per-field autosave.
//
// Typing a title used to leave the slug on its `item` placeholder until save,
// and the overlays then re-derived it UNCONDITIONALLY on save — clobbering a
// hand-typed slug and, because that always put `_slug` in the update, skipping
// `updateCollectionItem`'s uniqueness pass (user report 2026-07-25). The slug
// now follows the title live while the two are LINKED, stops the moment the
// user types their own, and re-links when the field is cleared.

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { CollectionSchema, CollectionItem } from '@/shared/types';
import ItemEditor from './ItemEditor';

const schema: CollectionSchema = {
  slug: 'blog',
  name: 'Blog',
  fields: [
    { id: 'title', name: 'Title', type: 'text', required: true },
    { id: 'body', name: 'Body', type: 'textarea' },
  ],
};

function makeItem(over: Partial<CollectionItem> = {}): CollectionItem {
  return {
    _id: 'i1',
    _slug: 'item',
    _status: 'draft',
    _createdAt: '2026-01-01T00:00:00.000Z',
    _updatedAt: '2026-01-01T00:00:00.000Z',
    title: '',
    ...over,
  } as CollectionItem;
}

function setup(item: CollectionItem, siblings: CollectionItem[] = []) {
  const onSave = vi.fn();
  render(
    <ItemEditor
      schema={schema}
      item={item}
      siblingItems={[item, ...siblings]}
      onSave={onSave}
      onCancel={() => {}}
    />,
  );
  const slug = () => screen.getByPlaceholderText('url-slug') as HTMLInputElement;
  const title = () => screen.getByDisplayValue(String(item.title ?? '')) as HTMLInputElement;
  return { onSave, slug, title };
}

/** Type into the title field (looked up fresh — its value changes as we go). */
function typeTitle(value: string) {
  const inputs = screen.getAllByRole('textbox') as HTMLInputElement[];
  fireEvent.change(inputs[0], { target: { value } });
}

describe('ItemEditor slug ↔ title sync', () => {
  it('fills the slug from the title as you type (placeholder slug)', () => {
    const { slug } = setup(makeItem());
    typeTitle("The worst advice we've ever heard about web design");
    expect(slug().value).toBe('the-worst-advice-weve-ever-heard-about-web-design');
  });

  it('keeps following the title on every keystroke', () => {
    const { slug } = setup(makeItem({ _slug: 'hello-world', title: 'Hello World' }));
    typeTitle('Hello Worlds');
    expect(slug().value).toBe('hello-worlds');
    typeTitle('Goodbye');
    expect(slug().value).toBe('goodbye');
  });

  it('suffixes away from a sibling that owns the slug', () => {
    const { slug } = setup(makeItem(), [makeItem({ _id: 'i2', _slug: 'hello' })]);
    typeTitle('Hello');
    expect(slug().value).toBe('hello-2');
  });

  it('stops syncing once the slug is edited by hand', () => {
    const { slug } = setup(makeItem());
    typeTitle('First Title');
    fireEvent.change(slug(), { target: { value: 'my-custom-url' } });
    typeTitle('Second Title');
    expect(slug().value).toBe('my-custom-url');
  });

  it('never syncs over a slug that was already hand-typed', () => {
    const { slug } = setup(makeItem({ _slug: 'my-custom-url', title: 'First Title' }));
    typeTitle('Second Title');
    expect(slug().value).toBe('my-custom-url');
  });

  it('re-links (and refills) when the slug field is cleared', () => {
    const { slug } = setup(makeItem());
    typeTitle('First Title');
    fireEvent.change(slug(), { target: { value: 'custom' } });
    fireEvent.change(slug(), { target: { value: '' } });
    expect(slug().value).toBe('first-title'); // refilled from the current title
    typeTitle('Third Title');
    expect(slug().value).toBe('third-title'); // and following again
  });

  it('normalizes hand-typed input to a URL key', () => {
    const { slug } = setup(makeItem());
    fireEvent.change(slug(), { target: { value: 'My Custom URL!!' } });
    expect(slug().value).toBe('my-custom-url-');
  });

  it('saves the synced slug', () => {
    const { onSave, slug } = setup(makeItem());
    typeTitle('Hello World');
    fireEvent.click(screen.getByText('Save'));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0]._slug).toBe('hello-world');
    expect(slug().value).toBe('hello-world');
  });
});

// ─── Autosave ────────────────────────────────────────────────────────────────
//
// The draft used to live only in this component until Save was pressed — type
// a title, reload, work gone (nothing had touched projectFS, so nothing
// scheduled a backend save). Every field now commits when focus leaves it.

describe('ItemEditor autosave', () => {
  it('commits when focus leaves a field', () => {
    const { onSave } = setup(makeItem());
    typeTitle('Hello World');
    expect(onSave).not.toHaveBeenCalled();          // still typing
    fireEvent.blur(screen.getAllByRole('textbox')[0]);
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0].title).toBe('Hello World');
  });

  it('carries the synced slug into the blur commit', () => {
    const { onSave } = setup(makeItem());
    typeTitle('Hello World');
    fireEvent.blur(screen.getAllByRole('textbox')[0]);
    expect(onSave.mock.calls[0][0]._slug).toBe('hello-world');
  });

  it('does NOT commit on blur when nothing changed', () => {
    const { onSave, slug } = setup(makeItem({ _slug: 'hello', title: 'Hello' }));
    fireEvent.blur(slug());
    expect(onSave).not.toHaveBeenCalled();
  });

  it('commits pending edits on unmount (overlay close / item switch)', () => {
    const onSave = vi.fn();
    const item = makeItem();
    const { unmount } = render(
      <ItemEditor schema={schema} item={item} siblingItems={[item]} onSave={onSave} onCancel={() => {}} />,
    );
    typeTitle('Half Typed');
    expect(onSave).not.toHaveBeenCalled();
    unmount();
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0].title).toBe('Half Typed');
  });

  it('adopts an EXTERNAL change to the item without a remount', () => {
    const onSave = vi.fn();
    const item = makeItem({ title: 'Original' });
    const { rerender } = render(
      <ItemEditor schema={schema} item={item} siblingItems={[item]} onSave={onSave} onCancel={() => {}} />,
    );
    const edited = { ...item, title: 'Agent Wrote This', _updatedAt: '2026-02-02T00:00:00.000Z' };
    rerender(
      <ItemEditor schema={schema} item={edited} siblingItems={[edited]} onSave={onSave} onCancel={() => {}} />,
    );
    expect((screen.getAllByRole('textbox')[0] as HTMLInputElement).value).toBe('Agent Wrote This');
  });

  it('does NOT clobber in-progress typing on an unrelated re-render', () => {
    const onSave = vi.fn();
    const item = makeItem({ title: 'Original' });
    const { rerender } = render(
      <ItemEditor schema={schema} item={item} siblingItems={[item]} onSave={onSave} onCancel={() => {}} />,
    );
    typeTitle('User Is Typing');
    // Same CONTENT, fresh object identity — getCollectionData re-parses JSON
    // on every read, so the item prop changes identity constantly.
    rerender(
      <ItemEditor schema={schema} item={{ ...item }} siblingItems={[item]} onSave={onSave} onCancel={() => {}} />,
    );
    expect((screen.getAllByRole('textbox')[0] as HTMLInputElement).value).toBe('User Is Typing');
  });
});
