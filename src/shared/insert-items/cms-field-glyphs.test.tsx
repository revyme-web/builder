// cms-field-glyphs.test.tsx — smoke gate for the Insert-panel CMS card
// drawings. Every field type must render a non-empty glyph (the GridCard
// falls back to a flat icon only when no glyph is produced), and the nav +
// collection glyphs must render too.

import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { CmsFieldGlyph, CmsNavGlyph, CmsCollectionGlyph } from '@/shared/insert-items/cms-field-glyphs';
import { FIELD_TYPES } from '@/code/project/cms-ops';

describe('CmsFieldGlyph', () => {
  for (const { value } of FIELD_TYPES) {
    it(`renders a glyph for the "${value}" field type`, () => {
      const { container } = render(<CmsFieldGlyph type={value} />);
      expect(container.firstChild).not.toBeNull();
      expect(container.textContent).toBeDefined();
    });
  }
});

describe('CmsNavGlyph', () => {
  it('renders the previous pager drawing', () => {
    const { container } = render(<CmsNavGlyph dir="prev" />);
    expect(container.querySelectorAll('svg').length).toBe(2);
  });

  it('renders the next pager drawing', () => {
    const { container } = render(<CmsNavGlyph dir="next" />);
    expect(container.querySelectorAll('svg').length).toBe(2);
  });
});

describe('CmsCollectionGlyph', () => {
  it('renders the records-list drawing', () => {
    const { container } = render(<CmsCollectionGlyph />);
    expect(container.firstChild).not.toBeNull();
  });
});
