// CmsBoundPill.test.ts — one binding, one label.
//
// User report 2026-08-08: after binding a component instance's props inside a
// collection list, the DESKTOP pills read "Question" / "Answer" (the schema's
// display names) but the TABLET replica pills read "title" / "untitled" (the
// raw field IDs the JSX carries). Two pill variants had derived the label two
// different ways for the same binding; both now go through `cmsFieldLabel`.

import { describe, it, expect } from 'vitest';
import { cmsFieldLabel } from './CmsBoundPill';

const schema = [
  { id: 'title', name: 'Question', type: 'text' },
  { id: 'untitled', name: 'Answer', type: 'richtext' },
  { id: 'cover', name: 'Cover Image', type: 'image' },
];

describe('cmsFieldLabel', () => {
  it('resolves the field ID to the schema display name', () => {
    expect(cmsFieldLabel(schema, 'title')).toBe('Question');
    expect(cmsFieldLabel(schema, 'untitled')).toBe('Answer');
  });

  it('falls back to the ID for a field the schema no longer has', () => {
    // A detached or renamed binding still shows something recognisable.
    expect(cmsFieldLabel(schema, 'removed-field')).toBe('removed-field');
  });

  it('falls back to the ID when there is no schema at all', () => {
    expect(cmsFieldLabel(undefined, 'title')).toBe('title');
    expect(cmsFieldLabel([], 'title')).toBe('title');
  });

  it('falls back to the ID when the field carries an empty name', () => {
    // An empty label would render a blank pill — worse than the raw id.
    expect(cmsFieldLabel([{ id: 'title', name: '' }], 'title')).toBe('title');
  });
});
