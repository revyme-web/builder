import { describe, it, expect } from 'vitest';
import {
  createCollectionListInCode,
  bindFieldInCode,
  unbindFieldInCode,
  updateCollectionListConfigInCode,
  findClosingTag,
  findJSXElementByDataId,
} from './cms-gen';

describe('findClosingTag — self-closing same-tag children', () => {
  // Regression: a container with self-closing <div … /> children (CMS card
  // image + dot) made the depth matcher over-count → it overshot past the
  // container's own </div> into ANCESTOR closes → captureCollectionForPaste
  // sliced 2 extra `</div>` → unbalanced JSX → paste crash.
  it('stops at the container close, not an ancestor close', () => {
    const code = `<div data-id="outer"><div data-id="list"><div data-id="img" style={{ width: '1px' }} />text<div data-id="dot" />end</div></div>`;
    const start = findJSXElementByDataId(code, 'list');
    const closing = findClosingTag(code, start)!;
    const raw = code.slice(start, closing.closeTagEnd); // closeTagEnd is exclusive
    expect(raw).toBe(`<div data-id="list"><div data-id="img" style={{ width: '1px' }} />text<div data-id="dot" />end</div>`);
    expect(raw).not.toContain('data-id="outer"');
  });

  it('still balances real nested same-tag children', () => {
    const code = `<div data-id="a"><div data-id="b"><div data-id="c">x</div></div></div>after`;
    const start = findJSXElementByDataId(code, 'a');
    const closing = findClosingTag(code, start)!;
    const raw = code.slice(start, closing.closeTagEnd);
    expect(raw).toBe(`<div data-id="a"><div data-id="b"><div data-id="c">x</div></div></div>`);
    expect(raw).not.toContain('after');
  });
});

// ─── Test Fixtures ──────────────────────────────────────────────────────────

const BASIC_CODE = `import { motion } from 'framer-motion';
export default function Page() {
  return (
    <div data-id="root" style={{ display: 'flex' }}>
      <div data-id="card-list" style={{ display: 'grid' }}>
        <div data-id="card-1" style={{ padding: '16px' }}>
          <h3 data-id="card-title">John Doe</h3>
          <p data-id="card-role">Designer</p>
          <img data-id="card-photo" src="/placeholder.jpg" alt="Photo" />
        </div>
      </div>
    </div>
  );
}`;

const CODE_WITH_COLLECTION = `import { motion } from 'framer-motion';
import teamMembers from '@/cms/teamMembers.json';
export default function Page() {
  return (
    <div data-id="root" style={{ display: 'flex' }}>
      <div data-id="card-list" style={{ display: 'grid' }}>
      {teamMembers.map(item => (
        <div data-id="card-1" style={{ padding: '16px' }}>
          <h3 data-id="card-title">{item.name}</h3>
          <p data-id="card-role">{item.role}</p>
          <img data-id="card-photo" src={item.photo} alt="Photo" />
        </div>
      ))}
    </div>
    </div>
  );
}`;

// ─── createCollectionListInCode ─────────────────────────────────────────────

describe('createCollectionListInCode', () => {
  it('adds import and wraps children in .map()', () => {
    const templateJSX = `<div data-id="card-1" style={{ padding: '16px' }}>
          <h3 data-id="card-title">John Doe</h3>
        </div>`;

    const result = createCollectionListInCode(
      BASIC_CODE,
      'card-list',
      'teamMembers',
      templateJSX,
    );

    // Should have the import
    expect(result).toContain("import teamMembers from '@/cms/teamMembers.json'");
    // Should have the .map() expression
    expect(result).toContain('teamMembers.map(item =>');
    // Should still have the parent element
    expect(result).toContain('data-id="card-list"');
  });

  it('does not duplicate import if already present', () => {
    const codeWithImport = `import teamMembers from '@/cms/teamMembers.json';
export default function Page() {
  return (
    <div data-id="root">
      <div data-id="card-list">
        <div data-id="card-1">Hello</div>
      </div>
    </div>
  );
}`;

    const result = createCollectionListInCode(
      codeWithImport,
      'card-list',
      'teamMembers',
      '<div data-id="card-1">Hello</div>',
    );

    // Count occurrences of the import
    const matches = result.match(/@\/cms\/teamMembers\.json/g);
    expect(matches).toHaveLength(1);
  });

  it('returns unchanged code if parent not found', () => {
    const result = createCollectionListInCode(
      BASIC_CODE,
      'nonexistent',
      'teamMembers',
      '<div>Template</div>',
    );

    expect(result).toBe(BASIC_CODE);
  });

  it('places import after existing imports', () => {
    const result = createCollectionListInCode(
      BASIC_CODE,
      'card-list',
      'blogPosts',
      '<div>Post</div>',
    );

    // The new import should appear after the framer-motion import
    const motionIdx = result.indexOf("from 'framer-motion'");
    const cmsIdx = result.indexOf("from '@/cms/blogPosts.json'");
    expect(cmsIdx).toBeGreaterThan(motionIdx);
  });
});

// ─── bindFieldInCode ────────────────────────────────────────────────────────

describe('bindFieldInCode', () => {
  it('binds text content with expression', () => {
    const result = bindFieldInCode(
      BASIC_CODE,
      'card-title',
      'text',
      'name',
      'item',
    );

    expect(result).toContain('{item.name}');
    // Original static text should be gone
    expect(result).not.toContain('>John Doe<');
  });

  it('binds src attribute with expression', () => {
    const result = bindFieldInCode(
      BASIC_CODE,
      'card-photo',
      'src',
      'photoUrl',
      'item',
    );

    expect(result).toContain('src={item.photoUrl}');
    expect(result).not.toContain('src="/placeholder.jpg"');
  });

  it('binds href attribute with expression', () => {
    const codeWithLink = `<a data-id="link-1" href="/static-page" style={{}}>Click</a>`;

    const result = bindFieldInCode(
      codeWithLink,
      'link-1',
      'href',
      'url',
      'item',
    );

    expect(result).toContain('href={item.url}');
    expect(result).not.toContain('href="/static-page"');
  });

  it('binds alt attribute with expression', () => {
    const result = bindFieldInCode(
      BASIC_CODE,
      'card-photo',
      'alt',
      'altText',
      'item',
    );

    expect(result).toContain('alt={item.altText}');
    expect(result).not.toContain('alt="Photo"');
  });

  it('returns unchanged code if node not found', () => {
    const result = bindFieldInCode(
      BASIC_CODE,
      'nonexistent',
      'text',
      'name',
      'item',
    );

    expect(result).toBe(BASIC_CODE);
  });

  it('replaces existing expression binding', () => {
    const codeWithBinding = `<h3 data-id="card-title">{item.name}</h3>`;

    // Re-bind to a different field via text
    const result = bindFieldInCode(
      codeWithBinding,
      'card-title',
      'text',
      'fullName',
      'item',
    );

    expect(result).toContain('{item.fullName}');
    expect(result).not.toContain('{item.name}');
  });

  it('replaces existing expression attribute binding', () => {
    const codeWithBinding = `<img data-id="img-1" src={item.photo} />`;

    const result = bindFieldInCode(
      codeWithBinding,
      'img-1',
      'src',
      'avatar',
      'item',
    );

    expect(result).toContain('src={item.avatar}');
    expect(result).not.toContain('src={item.photo}');
  });
});

// ─── unbindFieldInCode ──────────────────────────────────────────────────────

describe('unbindFieldInCode', () => {
  it('restores static text from expression', () => {
    const codeWithBinding = `<h3 data-id="card-title">{item.name}</h3>`;

    const result = unbindFieldInCode(
      codeWithBinding,
      'card-title',
      'text',
      'Default Name',
    );

    expect(result).toContain('>Default Name<');
    expect(result).not.toContain('{item.name}');
  });

  it('restores static src from expression', () => {
    const codeWithBinding = `<img data-id="card-photo" src={item.photo} alt="Photo" />`;

    const result = unbindFieldInCode(
      codeWithBinding,
      'card-photo',
      'src',
      '/placeholder.jpg',
    );

    expect(result).toContain('src="/placeholder.jpg"');
    expect(result).not.toContain('src={item.photo}');
  });

  it('restores static href from expression', () => {
    const codeWithBinding = `<a data-id="link-1" href={item.url}>Click</a>`;

    const result = unbindFieldInCode(
      codeWithBinding,
      'link-1',
      'href',
      '/default',
    );

    expect(result).toContain('href="/default"');
    expect(result).not.toContain('href={item.url}');
  });

  it('returns unchanged code if node not found', () => {
    const result = unbindFieldInCode(
      BASIC_CODE,
      'nonexistent',
      'text',
      'Fallback',
    );

    expect(result).toBe(BASIC_CODE);
  });

  it('returns unchanged code if no expression binding exists for attribute', () => {
    // Static attribute, not an expression
    const result = unbindFieldInCode(
      BASIC_CODE,
      'card-photo',
      'src',
      '/new-placeholder.jpg',
    );

    // src="/placeholder.jpg" is a static attribute, not {item.something}
    expect(result).toBe(BASIC_CODE);
  });
});

// ─── updateCollectionListConfigInCode ───────────────────────────────────────

describe('updateCollectionListConfigInCode', () => {
  it('adds a filter to an existing .map()', () => {
    const result = updateCollectionListConfigInCode(
      CODE_WITH_COLLECTION,
      'card-list',
      { combinator: 'and', filters: [{ field: 'role', operator: 'equals', value: 'Designer' }] },
    );

    expect(result).toContain('.filter(item => item.role === "Designer")');
    expect(result).toContain('.map(item =>');
  });

  it('adds sort to an existing .map()', () => {
    const result = updateCollectionListConfigInCode(
      CODE_WITH_COLLECTION,
      'card-list',
      undefined,
      { field: 'name', direction: 'asc' },
    );

    expect(result).toContain('.sort(');
    expect(result).toContain('.map(item =>');
  });

  it('adds limit to an existing .map()', () => {
    const result = updateCollectionListConfigInCode(
      CODE_WITH_COLLECTION,
      'card-list',
      undefined,
      undefined,
      5,
    );

    expect(result).toContain('.slice(0, 5)');
    expect(result).toContain('.map(item =>');
  });

  it('adds a start offset only → .slice(offset)', () => {
    const result = updateCollectionListConfigInCode(
      CODE_WITH_COLLECTION, 'card-list', undefined, undefined, undefined, 2,
    );
    expect(result).toContain('.slice(2)');
    expect(result).toContain('.map(item =>');
  });

  it('offset + limit → .slice(offset, offset + limit) (end index)', () => {
    const result = updateCollectionListConfigInCode(
      CODE_WITH_COLLECTION, 'card-list', undefined, undefined, 3, 2,
    );
    // offset 2, count 3 → end index 5
    expect(result).toContain('.slice(2, 5)');
    expect(result).not.toContain('.slice(0,');
  });

  it('adds filter + sort + limit combined', () => {
    const result = updateCollectionListConfigInCode(
      CODE_WITH_COLLECTION,
      'card-list',
      { combinator: 'and', filters: [{ field: 'active', operator: 'equals', value: true }] },
      { field: 'name', direction: 'desc' },
      10,
    );

    expect(result).toContain('.filter(');
    expect(result).toContain('.sort(');
    expect(result).toContain('.slice(0, 10)');
    expect(result).toContain('.map(item =>');

    // Verify order: filter before sort before slice before map
    const filterIdx = result.indexOf('.filter(');
    const sortIdx = result.indexOf('.sort(');
    const sliceIdx = result.indexOf('.slice(');
    const mapIdx = result.indexOf('.map(');
    expect(filterIdx).toBeLessThan(sortIdx);
    expect(sortIdx).toBeLessThan(sliceIdx);
    expect(sliceIdx).toBeLessThan(mapIdx);
  });

  it('supports OR combinator', () => {
    const result = updateCollectionListConfigInCode(
      CODE_WITH_COLLECTION,
      'card-list',
      {
        combinator: 'or',
        filters: [
          { field: 'role', operator: 'equals', value: 'Designer' },
          { field: 'role', operator: 'equals', value: 'Developer' },
        ],
      },
    );

    expect(result).toContain(' || ');
    expect(result).toContain('item.role === "Designer"');
    expect(result).toContain('item.role === "Developer"');
  });

  it('emits a `between` filter as a bounded comparison on the same field', () => {
    const result = updateCollectionListConfigInCode(
      CODE_WITH_COLLECTION,
      'card-list',
      { combinator: 'and', filters: [{ field: 'year', operator: 'between', value: [2020, 2023] }] },
    );
    expect(result).toContain('(item.year >= 2020 && item.year <= 2023)');
    expect(result).toContain('.map(item =>');
  });

  it('date-only value → compares the YYYY-MM-DD day (matches full ISO _createdAt)', () => {
    // A date picker emits "2026-06-15"; _createdAt is a full ISO timestamp, so a
    // plain `=== "2026-06-15"` would never match. The LHS must slice to the day.
    const result = updateCollectionListConfigInCode(
      CODE_WITH_COLLECTION,
      'card-list',
      { combinator: 'and', filters: [{ field: '_createdAt', operator: 'equals', value: '2026-06-15' }] },
    );
    expect(result).toContain('String(item._createdAt).slice(0, 10) === "2026-06-15"');
  });

  it('date gt / between also slice the day', () => {
    const gt = updateCollectionListConfigInCode(
      CODE_WITH_COLLECTION, 'card-list',
      { combinator: 'and', filters: [{ field: '_updatedAt', operator: 'gte', value: '2026-01-01' }] },
    );
    expect(gt).toContain('String(item._updatedAt).slice(0, 10) >= "2026-01-01"');
    const btw = updateCollectionListConfigInCode(
      CODE_WITH_COLLECTION, 'card-list',
      { combinator: 'and', filters: [{ field: 'date', operator: 'between', value: ['2026-01-01', '2026-12-31'] }] },
    );
    expect(btw).toContain('(String(item.date).slice(0, 10) >= "2026-01-01" && String(item.date).slice(0, 10) <= "2026-12-31")');
  });

  it('non-date equals stays a plain comparison (no slice)', () => {
    const result = updateCollectionListConfigInCode(
      CODE_WITH_COLLECTION, 'card-list',
      { combinator: 'and', filters: [{ field: 'role', operator: 'equals', value: 'Designer' }] },
    );
    expect(result).toContain('item.role === "Designer"');
    expect(result).not.toContain('.slice(0, 10) ===');
  });

  it('emits a SINGLE-key sort as one 3-branch comparator (no ||)', () => {
    const result = updateCollectionListConfigInCode(
      CODE_WITH_COLLECTION, 'card-list', undefined,
      [{ field: 'name', direction: 'asc' }],
    );
    expect(result).toContain('.sort((a, b) => (a.name > b.name ? 1 : a.name < b.name ? -1 : 0))');
    expect(result).not.toContain(' || ');
  });

  it('emits MULTIPLE sort keys joined by || in precedence order, mixed directions', () => {
    const result = updateCollectionListConfigInCode(
      CODE_WITH_COLLECTION, 'card-list', undefined,
      [{ field: 'year', direction: 'desc' }, { field: 'name', direction: 'asc' }],
    );
    expect(result).toContain('.sort((a, b) => (a.year > b.year ? -1 : a.year < b.year ? 1 : 0) || (a.name > b.name ? 1 : a.name < b.name ? -1 : 0))');
  });

  it('replaces existing filter/sort/limit', () => {
    // First add a filter
    const withFilter = updateCollectionListConfigInCode(
      CODE_WITH_COLLECTION,
      'card-list',
      { combinator: 'and', filters: [{ field: 'role', operator: 'equals', value: 'Designer' }] },
    );

    // Now update with a different filter
    const result = updateCollectionListConfigInCode(
      withFilter,
      'card-list',
      { combinator: 'and', filters: [{ field: 'active', operator: 'equals', value: true }] },
    );

    expect(result).toContain('item.active === true');
    expect(result).not.toContain('item.role === "Designer"');
    expect(result).toContain('.map(item =>');
  });

  it('removes filter/sort/limit when no config provided', () => {
    // First add filter + sort + limit
    const withConfig = updateCollectionListConfigInCode(
      CODE_WITH_COLLECTION,
      'card-list',
      { combinator: 'and', filters: [{ field: 'role', operator: 'equals', value: 'Designer' }] },
      { field: 'name', direction: 'asc' },
      5,
    );

    // Now call with no config — should strip everything back to just slug.map(...)
    const result = updateCollectionListConfigInCode(
      withConfig,
      'card-list',
    );

    expect(result).not.toContain('.filter(');
    expect(result).not.toContain('.sort(');
    expect(result).not.toContain('.slice(');
    expect(result).toContain('teamMembers.map(item =>');
  });

  it('returns unchanged code if parent not found', () => {
    const result = updateCollectionListConfigInCode(
      CODE_WITH_COLLECTION,
      'nonexistent',
    );

    expect(result).toBe(CODE_WITH_COLLECTION);
  });

  it('supports contains operator (case-insensitive)', () => {
    const result = updateCollectionListConfigInCode(
      CODE_WITH_COLLECTION,
      'card-list',
      { combinator: 'and', filters: [{ field: 'name', operator: 'contains', value: 'John' }] },
    );

    expect(result).toContain('String(item.name).toLowerCase().includes(String("John").toLowerCase())');
  });

  it('supports exists operator', () => {
    const result = updateCollectionListConfigInCode(
      CODE_WITH_COLLECTION,
      'card-list',
      { combinator: 'and', filters: [{ field: 'photo', operator: 'exists', value: true }] },
    );

    expect(result).toContain('item.photo != null');
  });

  it('supports desc sort direction (single config also accepted, emits 3-branch)', () => {
    const result = updateCollectionListConfigInCode(
      CODE_WITH_COLLECTION,
      'card-list',
      undefined,
      { field: 'createdAt', direction: 'desc' },
    );

    expect(result).toContain('.sort((a, b) => (a.createdAt > b.createdAt ? -1 : a.createdAt < b.createdAt ? 1 : 0))');
  });
});

// ─── bindFieldInCode for STYLE properties ─────────────────────────────────────
//
// The standard "+ Bind to Field" picker on every property reuses the
// same `bindFieldInCode` entry point as text/src/href, dispatching to a
// style-object rewriter when the property isn't a known JSX attribute.
// These tests cover the three shapes the rewriter has to handle.

describe('bindFieldInCode (style properties)', () => {
  it('inserts a new style key when the element has no `style` attribute', () => {
    const code = `export default function Page() {
  return <div data-id="card">A</div>;
}`;
    const result = bindFieldInCode(code, 'card', 'backgroundColor', 'brand', 'item');
    expect(result).toContain('style={{ backgroundColor: item.brand }}');
  });

  it('appends a new style key to an existing style object', () => {
    const code = `export default function Page() {
  return <div data-id="card" style={{ padding: '8px' }}>A</div>;
}`;
    const result = bindFieldInCode(code, 'card', 'backgroundColor', 'brand', 'item');
    expect(result).toContain("padding: '8px'");
    expect(result).toContain('backgroundColor: item.brand');
  });

  it('replaces an existing style key (rebinding)', () => {
    const code = `export default function Page() {
  return <div data-id="card" style={{ padding: '8px', backgroundColor: '#fff' }}>A</div>;
}`;
    const result = bindFieldInCode(code, 'card', 'backgroundColor', 'brand', 'item');
    // Old static colour gone, binding present, padding untouched.
    expect(result).not.toContain("backgroundColor: '#fff'");
    expect(result).toContain('backgroundColor: item.brand');
    expect(result).toContain("padding: '8px'");
  });

  it('returns code unchanged when the element is not found', () => {
    const code = `export default function Page() { return <div data-id="card">A</div>; }`;
    const result = bindFieldInCode(code, 'missing', 'backgroundColor', 'brand', 'item');
    expect(result).toBe(code);
  });

  it('treats `textContent` as an alias for `text` (rewrites child text, not style)', () => {
    // Regression: the property name in PropertiesPanel's text Content row
    // is `textContent`, not `text`. Falling through to bindStyleFieldInCode
    // produced `style={{ ..., textContent: item.title }}` and left the
    // child static text untouched — exactly the broken JSX the user hit.
    const code = `export default function Page() {
  return <p data-id="t" style={{ fontSize: '20px' }}>Old</p>;
}`;
    const result = bindFieldInCode(code, 't', 'textContent', 'title', 'item');
    expect(result).toContain('{item.title}');
    expect(result).not.toContain('textContent: item.title');
    // Style attribute stays intact and untouched.
    expect(result).toContain("fontSize: '20px'");
  });

  it('returns code unchanged when property is empty / whitespace', () => {
    // Decorative ControlLabels (group headers) pass `property=""`. The
    // bind menu is gated against them upstream, but `bindFieldInCode` is
    // a public API so it self-protects too — the alternative is a JSX
    // parse error from `style={{ : item.x }}`.
    const code = `export default function Page() { return <p data-id="t">A</p>; }`;
    expect(bindFieldInCode(code, 't', '', 'title', 'item')).toBe(code);
    expect(bindFieldInCode(code, 't', '   ', 'title', 'item')).toBe(code);
  });

  it('rewrites Fill (`backgroundColor`) to `backgroundImage: url(...)` when the picked field is an image', () => {
    // The standard picker offers both colour and image fields under
    // Fill. Picking an image must NOT produce `backgroundColor: item.cover`
    // (CSS would drop it) — instead the rewriter emits the proper
    // template-literal `url(...)` plus cover/center defaults so the image
    // shows immediately.
    const code = `export default function Page() {
  return <div data-id="hero" style={{ backgroundColor: '#fff', padding: '8px' }}>x</div>;
}`;
    const result = bindFieldInCode(code, 'hero', 'backgroundColor', 'cover', 'item', 'image');
    // Color slot is gone (image replaced it).
    expect(result).not.toContain("backgroundColor: '#fff'");
    expect(result).not.toContain('backgroundColor: item.cover');
    // backgroundImage with a JS template literal — that's the only shape
    // React accepts for "url that depends on a runtime value".
    expect(result).toContain('backgroundImage: `url(${item.cover})`');
    // Sane defaults so the bound image renders without further config.
    expect(result).toContain("backgroundSize: 'cover'");
    expect(result).toContain("backgroundPosition: 'center'");
    // Existing unrelated style stays intact.
    expect(result).toContain("padding: '8px'");
  });

  it('still uses `backgroundColor` for color-typed fields on Fill', () => {
    // Sanity for the dispatch — only image/file fields take the
    // backgroundImage path; a color field stays in the colour slot.
    const code = `export default function Page() {
  return <div data-id="hero" style={{ padding: '8px' }}>x</div>;
}`;
    const result = bindFieldInCode(code, 'hero', 'backgroundColor', 'brand', 'item', 'color');
    expect(result).toContain('backgroundColor: item.brand');
    expect(result).not.toContain('backgroundImage');
  });

  // Regression: the unbind regex used to fall back to `[^,}]+` for unknown
  // value shapes, which choked on template literals like `url(${item.x})` —
  // the first `}` from the interpolation cut the match short and left a
  // stray `})\`` behind, producing a "JSX expressions must have one parent
  // element" syntax error in VS Code.
  it('unbinds an image-typed field cleanly even when value is a template literal', () => {
    const code = `export default function Page() {
  return (
    <div data-id="img" style={{
      width: '60px',
      height: '60px',
      backgroundImage: \`url(\${item.cover})\`,
      backgroundSize: 'cover',
      backgroundPosition: 'center',
      flexShrink: '0'
    }} />
  );
}`;
    const result = unbindFieldInCode(code, 'img', 'backgroundColor', '');
    // No leftover template-literal residue.
    expect(result).not.toContain('backgroundImage');
    expect(result).not.toContain('item.cover');
    expect(result).not.toMatch(/`\)/);
    // Cascade clears the helper background-* keys too.
    expect(result).not.toContain('backgroundSize');
    expect(result).not.toContain('backgroundPosition');
    // Unrelated keys remain intact.
    expect(result).toContain("width: '60px'");
    expect(result).toContain("flexShrink: '0'");
  });
});
