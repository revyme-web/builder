import { describe, test, expect } from 'vitest';
import {
  dormantizeCmsBindings,
  rehydrateCmsBindings,
  clearCmsOrphanInCode,
  parseOrphanBindings,
  healDanglingCanvasNodeBindings,
  dormantizeCloneStyleBindings,
  dormantizeCloneTextBinding,
  dormantizeCloneAttrBindings,
  dormantizeCloneBindings,
  bakeCmsValuesOnClone,
  bakeCmsOrphanValuesInCode,
  detachCmsSubtreeWithValues,
} from './cms-detach-gen';
import { getEnclosingMapIteratorForNode } from './map-gen';

// A component instance dragged OUT to canvasNodes, still carrying its live
// `item.*` prop bindings (the state right after moveNodeInCode, before strip).
const DETACHED = `
const canvasNodes = (
  <>
    <HuQiBi data-id="inst-1" data-name="Card" content={item.title} ergerg={item.untitled} ergergerg={item.image} style={{ width: '300px' }} />
  </>
);
`;

// The same instance dropped INTO a new collection list (iterator \`row\`),
// carrying the orphan stash from a prior detach.
const REATTACHED = `
export default function Page() {
  return (
    <div data-id="root">
      {team.map((row, idx) => (
        <HuQiBi key={idx} data-id="inst-1" data-name="Card" data-cms-orphan="content:title,ergerg:untitled,ergergerg:image" style={{ width: '300px' }} />
      ))}
    </div>
  );
}
`;

describe('parseOrphanBindings', () => {
  test('parses prop:field pairs', () => {
    expect(parseOrphanBindings('content:title,ergerg:untitled')).toEqual([
      { prop: 'content', field: 'title' },
      { prop: 'ergerg', field: 'untitled' },
    ]);
  });
  test('tolerates blanks and missing colons', () => {
    expect(parseOrphanBindings(' content:title , , bogus ')).toEqual([
      { prop: 'content', field: 'title' },
    ]);
  });
  test('empty string → []', () => {
    expect(parseOrphanBindings('')).toEqual([]);
  });
  test('a `:url` third segment marks a whole-value image binding (urlWrap)', () => {
    expect(parseOrphanBindings('coverImage:coverImage:url,title2:title2')).toEqual([
      { prop: 'coverImage', field: 'coverImage', urlWrap: true },
      { prop: 'title2', field: 'title2' },
    ]);
  });
});

describe('getEnclosingMapIteratorForNode', () => {
  test('returns the iterator when the node is inside a .map()', () => {
    expect(getEnclosingMapIteratorForNode(REATTACHED, 'inst-1')).toBe('row');
  });
  test('returns null when the node is outside any .map() (detached on canvas)', () => {
    expect(getEnclosingMapIteratorForNode(DETACHED, 'inst-1')).toBeNull();
  });
});

describe('dormantizeCmsBindings — strip live item.* bindings on exit', () => {
  test('strips every item.* prop and stashes them in data-cms-orphan', () => {
    const out = dormantizeCmsBindings(DETACHED, 'inst-1', 'item');
    // No live `item.` reference survives → would-be crash is gone.
    expect(out).not.toContain('item.');
    expect(out).not.toContain('content={item.title}');
    // The intent is remembered.
    expect(out).toContain('data-cms-orphan="content:title,ergerg:untitled,ergergerg:image"');
    // Untouched props stay.
    expect(out).toContain("style={{ width: '300px' }}");
  });

  test('no-op when the tag has no bindings for the iterator', () => {
    const code = `<><Foo data-id="x" bar="static" /></>`;
    expect(dormantizeCmsBindings(code, 'x', 'item')).toBe(code);
  });

  test('merges with an existing orphan stash (last write per prop wins)', () => {
    const code = `<><Card data-id="c1" data-cms-orphan="name:oldName" title={item.title} /></>`;
    const out = dormantizeCmsBindings(code, 'c1', 'item');
    expect(out).toContain('name:oldName');
    expect(out).toContain('title:title');
    expect(out).not.toContain('item.');
  });

  test('strips key={idx} + a slug-link template (interpolated iterator → master default), stashes simple field binds', () => {
    // Mirrors a CMS component instance dragged out of its `.map()` into canvasNodes.
    const code = `<><NeMaUx key={idx} data-id="row-1" data-name="Link" style={{ order: "0" }} image={item.image} name={item.name} linkHref={\`/advisors/\${item?._slug ?? ''}\`} data-canvas-node="true" /></>`;
    const out = dormantizeCmsBindings(code, 'row-1', 'item');
    // No dangling iterator refs (item / idx) → no module-scope crash.
    expect(out).not.toMatch(/\bitem\b/);
    expect(out).not.toContain('key={idx}');
    // The slug link is removed (falls back to the component master default).
    expect(out).not.toContain('linkHref=');
    // Simple CMS data fields are stashed → "Missing" pills.
    expect(out).toContain('data-cms-orphan="image:image,name:name"');
    // Non-iterator attrs are preserved.
    expect(out).toContain('style={{ order: "0" }}');
    expect(out).toContain('data-canvas-node="true"');
  });

  test('strips key + slug template even with NO simple field binds (no early return)', () => {
    const code = `<><NeMaUx key={idx} data-id="row-2" linkHref={\`/x/\${item._slug}\`} /></>`;
    const out = dormantizeCmsBindings(code, 'row-2', 'item');
    expect(out).not.toContain('key={idx}');
    expect(out).not.toContain('linkHref=');
    expect(out).not.toMatch(/\bitem\b/);
  });

  test('strips a COMPUTED data-responsive carrying per-viewport item.field rebinds (no module-scope item ref)', () => {
    // An instance with per-viewport CMS rebindings dragged out of its .map().
    const code = `<><CoGaTa data-id="row-3" projectTitle={item.title} data-responsive={JSON.stringify({"768":{"projectTitle":item.shortTitle},"_bp":[1440,768,375]})} /></>`;
    const out = dormantizeCmsBindings(code, 'row-3', 'item');
    expect(out).not.toMatch(/\bitem\b/);          // no dangling iterator ref → no deploy crash
    expect(out).not.toContain('data-responsive');  // the computed attr is dropped
    expect(out).toContain('data-cms-orphan="projectTitle:title"'); // base binding still stashed
  });
});

describe('rehydrateCmsBindings — re-bind orphans on entry into a .map()', () => {
  test('re-binds each remembered prop to the NEW iterator and drops the stash', () => {
    const out = rehydrateCmsBindings(REATTACHED, 'inst-1');
    expect(out).toContain('content={row.title}');
    expect(out).toContain('ergerg={row.untitled}');
    expect(out).toContain('ergergerg={row.image}');
    expect(out).not.toContain('data-cms-orphan');
  });

  test('no-op when the node is NOT inside a .map() (stays "Missing")', () => {
    const code = `<><Card data-id="c1" data-cms-orphan="title:title" /></>`;
    expect(rehydrateCmsBindings(code, 'c1')).toBe(code);
  });

  test('REPLACES a literal the stash names (a baked value must not block re-binding)', () => {
    // Copy bakes the row's resolved value onto the detached node so it still
    // renders outside the list (`title="The worse advice…"`). The stash is what
    // says the prop was BOUND, so re-entry must overwrite that literal — an
    // earlier skip-if-present rule made the re-bind permanently unreachable.
    const code = `
      {team.map((row, idx) => (
        <Card key={idx} data-id="c1" data-cms-orphan="title:title" title="baked value" />
      ))}`;
    const out = rehydrateCmsBindings(code, 'c1');
    expect(out).toContain('title={row.title}');
    expect(out).not.toContain('title="baked value"');
    expect(out).not.toContain('data-cms-orphan');
    expect(out.match(/title=/g)?.length).toBe(1); // replaced, not duplicated
  });

  test('leaves props the stash does NOT name alone', () => {
    const code = `
      {team.map((row, idx) => (
        <Card key={idx} data-id="c1" data-cms-orphan="title:title" subtitle="mine" />
      ))}`;
    const out = rehydrateCmsBindings(code, 'c1');
    expect(out).toContain('subtitle="mine"');
    expect(out).toContain('title={row.title}');
  });
});

describe('round-trip: dormantize → rehydrate into a different collection', () => {
  test('bindings survive the trip, re-pointed to the new iterator', () => {
    // Exit the `item` map.
    const dormant = dormantizeCmsBindings(DETACHED, 'inst-1', 'item');
    expect(dormant).toContain('data-cms-orphan=');
    // Splice the dormant tag into a `row` map and rehydrate.
    const tag = dormant.match(/<HuQiBi[^>]*\/>/)![0];
    const inMap = `{team.map((row, idx) => (\n  ${tag}\n))}`;
    const out = rehydrateCmsBindings(inMap, 'inst-1');
    expect(out).toContain('content={row.title}');
    expect(out).toContain('ergerg={row.untitled}');
    expect(out).not.toContain('data-cms-orphan');
    expect(out).not.toContain('item.');
  });
});

describe('dormantizeCloneTextBinding — clone path (replica/variant detach)', () => {
  test('raw {iter.field} in textContent → __text orphan + humanized placeholder', () => {
    const { textContent, attrs } = dormantizeCloneTextBinding('{item.name}', undefined);
    expect(textContent).toBe('Name');
    expect(attrs?.['data-cms-orphan']).toContain('__text:name');
  });

  test('STRUCTURED binding (empty textContent + bindingField) → __text orphan + placeholder', () => {
    // Regression: the parser stores `<h3>{item.name}</h3>` as node.binding with
    // EMPTY textContent, so a CMS row dragged out of a replica/variant cloned with
    // empty text and NO Missing pill. The bindingField now drives the dormantize.
    const { textContent, attrs } = dormantizeCloneTextBinding(undefined, undefined, 'name');
    expect(textContent).toBe('Name');
    expect(attrs?.['data-cms-orphan']).toContain('__text:name');
  });

  test('plain (non-binding) text is untouched, no orphan', () => {
    const { textContent, attrs } = dormantizeCloneTextBinding('Hello world', undefined);
    expect(textContent).toBe('Hello world');
    expect(attrs).toBeUndefined();
  });

  test('resolved literal text wins over bindingField (textContent non-empty → no orphan)', () => {
    // If the clone already baked a literal value, don't override it with a Missing pill.
    const { textContent, attrs } = dormantizeCloneTextBinding('Marcus Chen', undefined, 'name');
    expect(textContent).toBe('Marcus Chen');
    expect(attrs?.['data-cms-orphan']).toBeUndefined();
  });
});

// WHOLE-VALUE image bindings (`prop={`url(${item.field})`}`) — the instance wraps
// the plain-URL CMS field because the master binds the prop bare. Detach must
// stash them (with the `:url` marker) instead of letting stripDanglingMapAttrs
// silently drop them, and re-entry must RE-WRAP on the new iterator.
describe('whole-value image binding (urlWrap) — detach → re-enter round-trip', () => {
  const DETACHED_WRAPPED = `
const canvasNodes = (
  <>
    <CoKaGo data-id="inst-9" data-name="Card" coverImage={\`url(\${item.coverImage})\`} title2={item.title2} style={{ width: '300px' }} />
  </>
);
`;

  test('dormantize stashes the wrapped binding with the :url marker and strips it', () => {
    const out = dormantizeCmsBindings(DETACHED_WRAPPED, 'inst-9', 'item');
    expect(out).not.toContain('url(${item.coverImage})');
    expect(out).toContain('coverImage:coverImage:url');
    expect(out).toContain('title2:title2');   // plain sibling stashed too
  });

  test('rehydrate re-wraps the whole-value binding on the new iterator', () => {
    const reattached = `
export default function Page() {
  return (
    <div data-id="root">
      {team.map((row, idx) => (
        <CoKaGo key={idx} data-id="inst-9" data-name="Card" data-cms-orphan="coverImage:coverImage:url,title2:title2" style={{ width: '300px' }} />
      ))}
    </div>
  );
}
`;
    const out = rehydrateCmsBindings(reattached, 'inst-9');
    expect(out).toContain('coverImage={\`url(\${row.coverImage})\`}');
    expect(out).toContain('title2={row.title2}');
    expect(out).not.toContain('data-cms-orphan');
  });
});

describe('clearCmsOrphanInCode — the "Missing" pill ×', () => {
  test('removes one orphan entry, keeps the rest', () => {
    const code = `<><Card data-id="c1" data-cms-orphan="content:title,ergerg:untitled" /></>`;
    const out = clearCmsOrphanInCode(code, 'c1', 'content');
    expect(out).toContain('data-cms-orphan="ergerg:untitled"');
    expect(out).not.toContain('content:title');
  });

  test('drops the whole attr when the last entry is cleared', () => {
    const code = `<><Card data-id="c1" data-cms-orphan="content:title" /></>`;
    const out = clearCmsOrphanInCode(code, 'c1', 'content');
    expect(out).not.toContain('data-cms-orphan');
  });

  test('dormantizes a bound TEXT child {item.field} dragged out (no dangling item ref)', () => {
    // A `<h3>{item.title}</h3>` dragged out of its .map() — the text child would
    // crash at module scope (oracle: "References undefined identifier: item").
    const code = `<h3 data-id="heading-1" style={{}}>{item.title}</h3>`;
    const out = dormantizeCmsBindings(code, 'heading-1', 'item');
    expect(out).toContain('data-cms-orphan="__text:title"');
    expect(out).toContain('>Title</h3>');                 // humanized placeholder
    // No live `item` reference survives (orphan attr value aside).
    expect(/\bitem\b/.test(out.replace(/data-cms-orphan="[^"]*"/, ''))).toBe(false);
  });

  test('rehydrates a dormantized TEXT binding back onto the new iterator', () => {
    const dormant = `<h3 data-id="heading-1" data-cms-orphan="__text:title" style={{}}>Title</h3>`;
    const inMap = `{posts.map((post, idx) => (${dormant}))}`;
    const out = rehydrateCmsBindings(inMap, 'heading-1');
    expect(out).toContain('>{post.title}</h3>');
    expect(out).not.toContain('data-cms-orphan');
  });

  test('humanizes system-field names for the placeholder', () => {
    const code = `<p data-id="p1">{item._createdAt}</p>`;
    const out = dormantizeCmsBindings(code, 'p1', 'item');
    expect(out).toContain('>Created At</p>');
    expect(out).toContain('data-cms-orphan="__text:_createdAt"');
  });

  test('heals a dangling {item.field} text stranded in canvasNodes; leaves in-map bindings alone', () => {
    const code = `export default function Page() {
  return <div data-id="root">
    {coll.slice(0, vis).map((item, idx) => <a data-id="row">{item.name}</a>)}
  </div>;
}
const canvasNodes = <>
  <h3 data-id="heading-4" style={{}}>{item.title}</h3>
</>;`;
    const out = healDanglingCanvasNodeBindings(code);
    expect(out).toContain('data-cms-orphan="__text:title"');
    expect(out).toContain('>Title</h3>');     // healed canvas node
    expect(out).toContain('{item.name}');     // in-.map() binding untouched (item in scope)
  });

  test('heals a WHOLE row dragged out — text child AND style-template image bg', () => {
    // Dragging the entire `<Link>` row out leaves nested `{item.name}` (text) AND
    // `url(${item.image})` (style) — both dangle at module scope.
    const code = `export default function Page() { return <div data-id="root">{advisors.map((item, idx) => null)}</div>; }
const canvasNodes = <>
  <a data-id="item-2" data-canvas-node="true">
    <div data-id="image-3" style={{ backgroundImage: \`url(\${item.image})\`, backgroundSize: 'cover' }}></div>
    <h3 data-id="heading-4" style={{ fontSize: '18px' }}>{item.name}</h3>
  </a>
</>;`;
    const out = healDanglingCanvasNodeBindings(code);
    expect(/\bitem\./.test(out)).toBe(false);                  // no dangling ref → deploy-safe
    expect(out).toContain('>Name</h3>');                       // text → placeholder
    expect(out).toContain('data-cms-orphan="__text:name"');    // text Missing stash
    expect(out).toContain('backgroundImage: `url()`');         // style value neutralized
    expect(out).toContain('data-cms-orphan="__style.backgroundImage:image"'); // image Missing stash
  });

  test('rehydrates a dormantized STYLE (image) binding back onto the new iterator', () => {
    const dormant = `<div data-id="image-3" data-cms-orphan="__style.backgroundImage:image" style={{ backgroundImage: \`url()\`, backgroundSize: 'cover' }}></div>`;
    const inMap = `{posts.map((post, idx) => (${dormant}))}`;
    const out = rehydrateCmsBindings(inMap, 'image-3');
    expect(out).toContain('backgroundImage: `url(${post.image})`');
    expect(out).not.toContain('data-cms-orphan');
  });

  test('heal is a no-op when nothing dangles', () => {
    const code = `<>{coll.map((item) => <a data-id="r">{item.name}</a>)}</>`;
    expect(healDanglingCanvasNodeBindings(code)).toBe(code);
  });

  test('dormantizeCloneStyleBindings neutralizes ${} style + stashes __style orphan', () => {
    const { styles, attrs } = dormantizeCloneStyleBindings(
      [{ styleProp: 'backgroundImage', field: 'image' }],
      { backgroundImage: 'url(${item.image})', backgroundSize: 'cover' },
      { 'data-id': 'image-3' },
    );
    expect(styles.backgroundImage).toBe('url()');     // interpolation stripped
    expect(styles.backgroundSize).toBe('cover');       // untouched
    expect(attrs?.['data-cms-orphan']).toBe('__style.backgroundImage:image'); // Missing stash
  });

  test('heal leaves ${item.field} INSIDE a canvasNodes .map() alone (in scope)', () => {
    const code = `const canvasNodes = <>{coll.map((item) => <div data-id="r" style={{ backgroundImage: \`url(\${item.image})\` }}></div>)}</>;`;
    expect(healDanglingCanvasNodeBindings(code)).toBe(code);
  });
});

// ─── Clone-path dormantize: attrs/props + the composed entry point ───────────
//
// Copy/paste and drag-out share ONE dormantizer now. Copy previously captured
// no binding at all: a duplicated `<h3>{item.title}</h3>` pasted as an empty
// text node, and pasting one outside the list lost the Missing pill
// (user report 2026-07-25).

describe('dormantizeCloneAttrBindings', () => {
  test('stashes src/href/alt bindings as plain prop:field entries', () => {
    const attrs = dormantizeCloneAttrBindings(
      [{ property: 'src', field: 'image' }, { property: 'alt', field: 'caption' }],
      undefined, undefined,
    );
    expect(attrs?.['data-cms-orphan']).toBe('src:image,alt:caption');
  });

  test('DELETES the bound attr (a leftover literal blocks the re-bind)', () => {
    // rehydrateCmsBindings skips any prop already on the tag, so a resolved
    // preview value left in `attrs` would make the binding unrecoverable.
    const attrs = dormantizeCloneAttrBindings(
      [{ property: 'src', field: 'image' }], undefined,
      { src: 'https://cdn/preview.png', alt: 'keep me' },
    );
    expect(attrs?.src).toBeUndefined();
    expect(attrs?.alt).toBe('keep me');
  });

  test('keeps the urlWrap marker for whole-value image props', () => {
    const attrs = dormantizeCloneAttrBindings(
      undefined, [{ prop: 'coverImage', field: 'cover', urlWrap: true }], undefined,
    );
    expect(attrs?.['data-cms-orphan']).toBe('coverImage:cover:url');
  });

  test('merges with an existing stash, replacing the same prop', () => {
    const attrs = dormantizeCloneAttrBindings(
      [{ property: 'src', field: 'newField' }], undefined,
      { 'data-cms-orphan': '__text:title,src:oldField' },
    );
    expect(attrs?.['data-cms-orphan']).toBe('__text:title,src:newField');
  });

  test('no bindings → attrs pass through untouched', () => {
    const attrs = { id: 'x' };
    expect(dormantizeCloneAttrBindings(undefined, undefined, attrs)).toBe(attrs);
  });
});

describe('dormantizeCloneBindings (composed — copy + drag-out share it)', () => {
  test('a bound <h3> copies with the field stashed, not an empty text node', () => {
    const out = dormantizeCloneBindings({
      textContent: undefined,          // structured binding leaves textContent EMPTY
      styles: {},
      attrs: undefined,
      textField: 'title',
    });
    expect(out.textContent).toBe('Title');
    expect(out.attrs?.['data-cms-orphan']).toBe('__text:title');
  });

  test('text + style + attr bindings all land in ONE stash', () => {
    const out = dormantizeCloneBindings({
      textContent: undefined,
      styles: { backgroundImage: 'url(${item.cover})', color: 'red' },
      attrs: { src: 'preview.png' },
      textField: 'title',
      attrBindings: [{ property: 'src', field: 'image' }],
      styleBindings: [{ styleProp: 'backgroundImage', field: 'cover' }],
    });
    const stash = out.attrs?.['data-cms-orphan'] ?? '';
    expect(stash).toContain('__text:title');
    expect(stash).toContain('__style.backgroundImage:cover');
    expect(stash).toContain('src:image');
    expect(out.styles.backgroundImage).toBe('url()');   // no out-of-scope ref
    expect(out.styles.color).toBe('red');
    expect(out.attrs?.src).toBeUndefined();
  });

  test('an unbound node is returned unchanged (no stash attr)', () => {
    const out = dormantizeCloneBindings({
      textContent: 'Plain heading', styles: { color: 'red' }, attrs: { id: 'x' },
    });
    expect(out.textContent).toBe('Plain heading');
    expect(out.attrs?.['data-cms-orphan']).toBeUndefined();
  });

  test('round-trips: dormantized copy pasted back INTO a list re-binds', () => {
    const out = dormantizeCloneBindings({
      textContent: undefined, styles: {}, attrs: undefined,
      textField: 'title',
      attrBindings: [{ property: 'href', field: 'link' }],
    });
    const pasted = `{blog.map((row, idx) => (\n  <h3 data-id="h3-copy" data-cms-orphan="${out.attrs!['data-cms-orphan']}">${out.textContent}</h3>\n))}`;
    const rebound = rehydrateCmsBindings(pasted, 'h3-copy');
    expect(rebound).toContain('{row.title}');
    expect(rebound).toContain('href={row.link}');
    expect(rebound).not.toContain('data-cms-orphan');
  });

  test('the SAME copy pasted OUTSIDE a list stays dormant (Missing pill)', () => {
    const out = dormantizeCloneBindings({
      textContent: undefined, styles: {}, attrs: undefined, textField: 'title',
    });
    const pasted = `<div data-id="root"><h3 data-id="h3-copy" data-cms-orphan="${out.attrs!['data-cms-orphan']}">Title</h3></div>`;
    expect(rehydrateCmsBindings(pasted, 'h3-copy')).toBe(pasted); // untouched
  });
});

// ─── Baking the ROW's resolved values onto a detached copy ──────────────────
//
// Dormantizing alone renders a placeholder ("Title", `url()`, no src). A node
// copied out of a collection list should still SAY what it said — so copy
// resolves the row's values and bakes them in, KEEPING the Missing stash
// (user report 2026-07-25).

describe('bakeCmsValuesOnClone', () => {
  const dormant = () => dormantizeCloneBindings({
    textContent: undefined,
    styles: { backgroundImage: 'url(${item.cover})' },
    attrs: undefined,
    textField: 'title',
    attrBindings: [{ property: 'src', field: 'image' }],
    styleBindings: [{ styleProp: 'backgroundImage', field: 'cover' }],
  });

  test('bakes text, attr and style values while KEEPING the stash', () => {
    const out = bakeCmsValuesOnClone(dormant(), {
      __text: "The worse advice we've ever heard about web design",
      src: 'https://cdn/row.png',
      '__style.backgroundImage': 'https://cdn/cover.png',
    });
    expect(out.textContent).toBe("The worse advice we've ever heard about web design");
    expect(out.attrs?.src).toBe('https://cdn/row.png');
    expect(out.styles.backgroundImage).toBe('url(https://cdn/cover.png)'); // re-wrapped
    expect(out.attrs?.['data-cms-orphan']).toContain('__text:title'); // pill survives
  });

  test('leaves the placeholder when the row has no value for a field', () => {
    const out = bakeCmsValuesOnClone(dormant(), { src: 'https://cdn/row.png' });
    expect(out.textContent).toBe('Title');       // humanized placeholder kept
    expect(out.styles.backgroundImage).toBe('url()');
    expect(out.attrs?.src).toBe('https://cdn/row.png');
  });

  test('ignores empty values', () => {
    const out = bakeCmsValuesOnClone(dormant(), { __text: '' });
    expect(out.textContent).toBe('Title');
  });

  test('only bakes props the stash names', () => {
    const out = bakeCmsValuesOnClone(dormant(), { unrelated: 'nope' });
    expect(out.attrs?.unrelated).toBeUndefined();
  });

  test('no stash → returns the clone untouched', () => {
    const clone = { textContent: 'Plain', styles: {}, attrs: undefined };
    expect(bakeCmsValuesOnClone(clone, { __text: 'x' })).toBe(clone);
  });

  test('a BAKED copy pasted back into a list re-binds over the literals', () => {
    const out = bakeCmsValuesOnClone(dormant(), {
      __text: 'Real heading', src: 'https://cdn/row.png',
      '__style.backgroundImage': 'https://cdn/cover.png',
    });
    const pasted = `{blog.map((row, idx) => (\n  <img data-id="c" data-cms-orphan="${out.attrs!['data-cms-orphan']}" src="${out.attrs!.src}" style={{ backgroundImage: 'url(https://cdn/cover.png)' }}>${out.textContent}</img>\n))}`;
    const rebound = rehydrateCmsBindings(pasted, 'c');
    expect(rebound).toContain('src={row.image}');
    expect(rebound).toContain('{row.title}');
    expect(rebound).toContain('backgroundImage: `url(${row.cover})`');
    expect(rebound).not.toContain('https://cdn/');
    expect(rebound).not.toContain('data-cms-orphan');
  });
});

// ─── detach with values (drag-out bake, user report 2026-07-28) ──────────────
// Dragging a bound text out of its collection list produced a node literally
// reading "Untitled" (humanizeField of the auto-named field `untitled`) with a
// Missing pill — instead of the text the row displayed. detachCmsSubtreeWithValues
// dormantizes the WHOLE dragged subtree and bakes the row's resolved values.
describe('detachCmsSubtreeWithValues', () => {
  const ROW = {
    title: 'The worse advice',
    untitled: 'Lorem ipsum body text',
    image: 'https://cdn/img.png',
    _slug: 'worse-advice',
  };

  test('bound TEXT dragged out bakes the row text and keeps the __text stash', () => {
    const code = `
const canvasNodes = (
  <>
    <motion.h3 data-id="h3-x" data-name="Untitled" style={{ width: '100%' }}>{item.untitled}</motion.h3>
  </>
);`;
    const out = detachCmsSubtreeWithValues(code, 'h3-x', 'item', ROW);
    expect(out).toContain('>Lorem ipsum body text</motion.h3>');
    expect(out).toContain('data-cms-orphan="__text:untitled"');
    expect(out).not.toContain('{item.untitled}');
  });

  test('a whole card subtree resolves nested text, img src/alt, style url and slug href', () => {
    const code = `
const canvasNodes = (
  <>
    <MotionLink data-id="card-x" href={\`/collection-1/\${item?._slug ?? ''}\`} data-cms-nav="row" style={{ display: 'flex' }}>
      <motion.div data-id="img-x" style={{ backgroundImage: \`url(\${item.image})\`, width: '100px' }} />
      <motion.img data-id="pic-x" src={item.image} alt={item.title} style={{ width: '48px' }} />
      <motion.h3 data-id="t-x" style={{ fontSize: '17px' }}>{item.title}</motion.h3>
    </MotionLink>
  </>
);`;
    const out = detachCmsSubtreeWithValues(code, 'card-x', 'item', ROW);
    // Slug link resolved to a static href instead of being dropped to the default.
    expect(out).toContain('href="/collection-1/worse-advice"');
    // Nested bound text baked; stash kept for re-entry.
    expect(out).toContain('>The worse advice</motion.h3>');
    expect(out).toContain('data-cms-orphan="__text:title"');
    // Style image binding neutralized + baked as a literal url.
    expect(out).toContain("backgroundImage: 'url(https://cdn/img.png)'");
    expect(out).toContain('data-cms-orphan="__style.backgroundImage:image"');
    // Attr bindings baked as literals with their stashes.
    expect(out).toContain('src="https://cdn/img.png"');
    expect(out).toContain('alt="The worse advice"');
    // No live iterator reference survives anywhere in the subtree.
    expect(out).not.toMatch(/\bitem[.?]/);
  });

  test('fields absent from the row keep the humanized placeholder', () => {
    const code = `
const canvasNodes = (
  <>
    <motion.h3 data-id="h3-x">{item.subtitle}</motion.h3>
  </>
);`;
    const out = detachCmsSubtreeWithValues(code, 'h3-x', 'item', ROW);
    expect(out).toContain('>Subtitle</motion.h3>');
    expect(out).toContain('data-cms-orphan="__text:subtitle"');
  });

  test('baked text re-binds on re-entry (rehydrate replaces the literal wholesale)', () => {
    const attached = `
export default function Page() {
  return (
    <div data-id="root">
      {team.map((row, idx) => (
        <motion.h3 key={idx} data-id="h3-x" data-cms-orphan="__text:untitled" style={{ width: '100%' }}>Lorem ipsum body text</motion.h3>
      ))}
    </div>
  );
}`;
    const out = rehydrateCmsBindings(attached, 'h3-x');
    expect(out).toContain('{row.untitled}');
    expect(out).not.toContain('Lorem ipsum body text');
    expect(out).not.toContain('data-cms-orphan');
  });
});

describe('bakeCmsOrphanValuesInCode', () => {
  test('missing/empty row fields leave the node untouched', () => {
    const code = `<motion.h3 data-id="a" data-cms-orphan="__text:missing">Missing</motion.h3>`;
    expect(bakeCmsOrphanValuesInCode(code, 'a', { other: 'x', missing: '' })).toBe(code);
  });

  test('urlWrap attr entry bakes url(value)', () => {
    const code = `<HuQiBi data-id="a" data-cms-orphan="cover:image:url" style={{ width: '10px' }} />`;
    const out = bakeCmsOrphanValuesInCode(code, 'a', { image: 'https://x/y.png' });
    expect(out).toContain('cover="url(https://x/y.png)"');
    expect(out).toContain('data-cms-orphan="cover:image:url"');
  });

  test('JSX-special characters in the row text are entity-escaped', () => {
    const code = `<motion.h3 data-id="a" data-cms-orphan="__text:title">Title</motion.h3>`;
    const out = bakeCmsOrphanValuesInCode(code, 'a', { title: 'A & B < C {x}' });
    expect(out).toContain('>A &amp; B &lt; C &#123;x&#125;</motion.h3>');
  });

  test('neutralized bare style value bakes the literal', () => {
    const code = `<motion.div data-id="a" data-cms-orphan="__style.backgroundColor:brand" style={{ backgroundColor: '', width: '10px' }} />`;
    const out = bakeCmsOrphanValuesInCode(code, 'a', { brand: '#ff0055' });
    expect(out).toContain("backgroundColor: '#ff0055'");
  });
});
