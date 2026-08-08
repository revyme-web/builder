import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getEnclosingMapParamsForNode,
  addMapItemInCode,
  removeMapItemInCode,
  updateMapItemInCode,
  addMapFieldInCode,
  makeIntoMapInCode,
  bindStyleToMapInCode,
  bindPropToMapInCode,
  unbindPropFromMapInCode,
  bindToCmsCollectionInCode,
  unbindFromCmsCollectionInCode,
  changeCollectionSourceInCode,
  bindCmsNavLinkOnDropInCode,
  setCmsNavHrefInCode,
} from './map-gen';
import { propagateToGhosts } from './map-ghost-propagate';
import { parseJSXToNodes } from '../parsing/parser';
import { queueMutation } from '../mutation/mutation-queue';

vi.mock('../mutation/mutation-queue', () => ({
  queueMutation: vi.fn(),
}));
const mockQueueMutation = vi.mocked(queueMutation);

// ─── Test Fixtures ──────────────────────────────────────────────────────────

const CODE_WITH_MAP = `export default function Page() {
  const cardData = [
    {"title":"Hello","desc":"World"},
    {"title":"Foo","desc":"Bar"},
  ];

  return (
    <div data-id="root">
      {cardData.map((item, idx) => (
        <div data-id="card" key={idx}>
          <h3>{item.title}</h3>
          <p>{item.desc}</p>
        </div>
      ))}
    </div>
  );
}`;

// ─── addMapItemInCode ─────────────────────────────────────────────────────────

describe('addMapItemInCode', () => {
  it('adds a new item to the data array', () => {
    const result = addMapItemInCode(CODE_WITH_MAP, 'cardData', { title: 'New', desc: 'Item' });
    expect(result).toContain('{"title":"New","desc":"Item"}');
    // Original items preserved
    expect(result).toContain('"title":"Hello"');
    expect(result).toContain('"title":"Foo"');
  });

  it('returns unchanged code when varName not found', () => {
    const result = addMapItemInCode(CODE_WITH_MAP, 'nonExistent', { x: '1' });
    expect(result).toBe(CODE_WITH_MAP);
  });
});

// ─── removeMapItemInCode ──────────────────────────────────────────────────────

describe('removeMapItemInCode', () => {
  it('removes item at index 0', () => {
    const result = removeMapItemInCode(CODE_WITH_MAP, 'cardData', 0);
    expect(result).not.toContain('"title":"Hello"');
    expect(result).toContain('"title":"Foo"');
  });

  it('removes item at index 1', () => {
    const result = removeMapItemInCode(CODE_WITH_MAP, 'cardData', 1);
    expect(result).toContain('"title":"Hello"');
    expect(result).not.toContain('"title":"Foo"');
  });

  it('returns unchanged code for out-of-bounds index', () => {
    const result = removeMapItemInCode(CODE_WITH_MAP, 'cardData', 5);
    expect(result).toBe(CODE_WITH_MAP);
  });
});

// ─── updateMapItemInCode ──────────────────────────────────────────────────────

describe('updateMapItemInCode', () => {
  it('updates item at index 0', () => {
    const result = updateMapItemInCode(CODE_WITH_MAP, 'cardData', 0, { title: 'Updated', desc: 'Content' });
    expect(result).toContain('{"title":"Updated","desc":"Content"}');
    // Second item unchanged
    expect(result).toContain('"title":"Foo"');
    expect(result).not.toContain('"title":"Hello"');
  });

  it('updates item at index 1', () => {
    const result = updateMapItemInCode(CODE_WITH_MAP, 'cardData', 1, { title: 'Changed', desc: 'Baz' });
    expect(result).toContain('{"title":"Changed","desc":"Baz"}');
    // First item unchanged
    expect(result).toContain('"title":"Hello"');
    expect(result).not.toContain('"title":"Foo"');
  });

  it('returns unchanged code for out-of-bounds index', () => {
    const result = updateMapItemInCode(CODE_WITH_MAP, 'cardData', 10, { title: 'X', desc: 'Y' });
    expect(result).toBe(CODE_WITH_MAP);
  });

  it('returns unchanged code when varName not found', () => {
    const result = updateMapItemInCode(CODE_WITH_MAP, 'noSuch', 0, { x: '1' });
    expect(result).toBe(CODE_WITH_MAP);
  });

  it('updated code at index 0 still parses correctly', () => {
    const result = updateMapItemInCode(CODE_WITH_MAP, 'cardData', 0, { title: 'New Title', desc: 'New Desc' });
    const nodes = parseJSXToNodes(result);
    const root = nodes.get('root');
    expect(root).toBeDefined();
    expect(root!.inlineMapData).toBeDefined();
    expect(root!.inlineMapData!.length).toBe(2);
    expect(root!.inlineMapData![0].title).toBe('New Title');
    expect(root!.inlineMapData![0].desc).toBe('New Desc');
    // Item 1 should be unchanged
    expect(root!.inlineMapData![1].title).toBe('Foo');
    expect(root!.inlineMapData![1].desc).toBe('Bar');
  });

  it('updates ghost item (index > 0) without affecting template item', () => {
    const result = updateMapItemInCode(CODE_WITH_MAP, 'cardData', 1, { title: 'Ghost Updated', desc: 'Ghost Desc' });
    const nodes = parseJSXToNodes(result);
    const root = nodes.get('root');
    expect(root).toBeDefined();
    expect(root!.inlineMapData).toBeDefined();
    expect(root!.inlineMapData!.length).toBe(2);
    // Item 0 (template) should be unchanged
    expect(root!.inlineMapData![0].title).toBe('Hello');
    expect(root!.inlineMapData![0].desc).toBe('World');
    // Item 1 (ghost) should have new values
    expect(root!.inlineMapData![1].title).toBe('Ghost Updated');
    expect(root!.inlineMapData![1].desc).toBe('Ghost Desc');
  });

  it('can add fields to items via update', () => {
    const result = updateMapItemInCode(CODE_WITH_MAP, 'cardData', 0, { title: 'Hello', desc: 'World', icon: 'star' });
    const nodes = parseJSXToNodes(result);
    const root = nodes.get('root');
    expect(root!.inlineMapData![0].icon).toBe('star');
    // Item 1 does NOT get the new field — update replaces only the targeted item
    expect(root!.inlineMapData![1].icon).toBeUndefined();
  });

  it('can update with 3+ items in the array', () => {
    // First add a third item, then update it
    let result = addMapItemInCode(CODE_WITH_MAP, 'cardData', { title: 'Third', desc: 'Entry' });
    result = updateMapItemInCode(result, 'cardData', 2, { title: 'Updated Third', desc: 'Updated Entry' });
    const nodes = parseJSXToNodes(result);
    const root = nodes.get('root');
    expect(root!.inlineMapData!.length).toBe(3);
    expect(root!.inlineMapData![0].title).toBe('Hello');
    expect(root!.inlineMapData![1].title).toBe('Foo');
    expect(root!.inlineMapData![2].title).toBe('Updated Third');
    expect(root!.inlineMapData![2].desc).toBe('Updated Entry');
  });
});

// ─── addMapFieldInCode ────────────────────────────────────────────────────────

describe('addMapFieldInCode', () => {
  it('adds a new field to all items', () => {
    const result = addMapFieldInCode(CODE_WITH_MAP, 'cardData', 'link', 'https://example.com');
    // Both items should now have the link field
    expect(result).toContain('"link":"https://example.com"');
    // Should appear twice (once per item)
    const matches = result.match(/"link":"https:\/\/example\.com"/g);
    expect(matches?.length).toBe(2);
    // Original fields preserved
    expect(result).toContain('"title":"Hello"');
    expect(result).toContain('"title":"Foo"');
  });

  it('adds field with empty default value', () => {
    const result = addMapFieldInCode(CODE_WITH_MAP, 'cardData', 'image');
    expect(result).toContain('"image":""');
    const matches = result.match(/"image":""/g);
    expect(matches?.length).toBe(2);
  });

  it('returns unchanged code when varName not found', () => {
    const result = addMapFieldInCode(CODE_WITH_MAP, 'noSuch', 'field');
    expect(result).toBe(CODE_WITH_MAP);
  });
});

// ─── Round-trip: code → parse → verify inlineMapData ─────────────────────────

describe('parser round-trip for inline maps', () => {
  it('parses .map() and finds inlineMapData on parent node', () => {
    const nodes = parseJSXToNodes(CODE_WITH_MAP);
    const root = nodes.get('root');
    expect(root).toBeDefined();
    expect(root!.collectionList).toBeDefined();
    expect(root!.collectionList!.source).toBe('__inline:cardData');
    expect(root!.inlineMapData).toBeDefined();
    expect(root!.inlineMapData!.length).toBe(2);
    expect(root!.inlineMapData![0].title).toBe('Hello');
    expect(root!.inlineMapData![1].title).toBe('Foo');
  });

  it('addMapItem produces code that parses with 3 items', () => {
    const newCode = addMapItemInCode(CODE_WITH_MAP, 'cardData', { title: 'New', desc: 'Item' });
    const nodes = parseJSXToNodes(newCode);
    const root = nodes.get('root');
    expect(root!.inlineMapData!.length).toBe(3);
    expect(root!.inlineMapData![2].title).toBe('New');
    expect(root!.inlineMapData![2].desc).toBe('Item');
  });

  it('removeMapItem produces code that parses with 1 item', () => {
    const newCode = removeMapItemInCode(CODE_WITH_MAP, 'cardData', 0);
    const nodes = parseJSXToNodes(newCode);
    const root = nodes.get('root');
    expect(root!.inlineMapData!.length).toBe(1);
    expect(root!.inlineMapData![0].title).toBe('Foo');
  });

  it('template children have bindings detected', () => {
    const nodes = parseJSXToNodes(CODE_WITH_MAP);
    const card = nodes.get('card');
    expect(card).toBeDefined();
    expect(card!.isCollectionTemplate).toBe(true);
  });

  it('parses inline map mixed with sibling elements', () => {
    const code = `export default function Page() {
    const card1Data = [
    {"title":"Code First","desc":"JSX is the source of truth."},
    {"title":"zegzegzeg","desc":"zegzegzegge"},];

  return (
<div data-id="root" style={{position: 'relative'}}>
  <div data-id="features" style={{display: 'flex', gap: '32px'}}>
    {card1Data.map((item, idx) => (
      <div data-id="card1" key={idx} style={{width: '320px'}}>
        <p data-id="card1-title">{item.title}</p>
        <p data-id="card1-desc">{item.desc}</p>
      </div>
    ))}
    <div data-id="card2" style={{width: '320px'}}>
      <p data-id="card2-title">Visual Canvas</p>
    </div>
  </div>
</div>
  );
}`;
    const nodes = parseJSXToNodes(code);
    const features = nodes.get('features');
    expect(features).toBeDefined();
    expect(features!.collectionList).toBeDefined();
    expect(features!.collectionList!.source).toBe('__inline:card1Data');
    expect(features!.collectionList!.templateIds['default']).toBe('card1');
    expect(features!.inlineMapData).toBeDefined();
    expect(features!.inlineMapData!.length).toBe(2);
    expect(features!.inlineMapData![0].title).toBe('Code First');
    expect(features!.inlineMapData![1].title).toBe('zegzegzeg');
    // card1 should be a collection template
    const card1 = nodes.get('card1');
    expect(card1).toBeDefined();
    expect(card1!.isCollectionTemplate).toBe(true);
    // card2 should NOT be a collection template (sibling, outside .map())
    const card2 = nodes.get('card2');
    expect(card2).toBeDefined();
    expect(card2!.isCollectionTemplate).toBeFalsy();
  });
});

// ─── makeIntoMapInCode: unique variable names ─────────────────────────────────

describe('makeIntoMapInCode variable name collision', () => {
  const CODE_TWO_CARDS = `export default function Page() {
  return (
    <div data-id="root">
      <div data-id="features" style={{display: 'flex'}}>
        <div data-id="card-1" style={{width: '320px'}}>
          <h3 data-id="card-1-title">First</h3>
        </div>
        <div data-id="card-2" style={{width: '320px'}}>
          <h3 data-id="card-2-title">Second</h3>
        </div>
      </div>
    </div>
  );
}`;

  it('generates unique var names for siblings with similar IDs', () => {
    // Make card-1 into a map
    const step1 = makeIntoMapInCode(CODE_TWO_CARDS, 'card-1');
    expect(step1).toContain('const card1Data');
    // Make card-2 into a map — should NOT collide
    const step2 = makeIntoMapInCode(step1, 'card-2');
    expect(step2).toContain('card2Data');
    // Both const declarations should exist
    expect(step2).toContain('const card1Data');
    expect(step2).toContain('const card2Data');
  });
});

// ─── bindStyleToMapInCode ─────────────────────────────────────────────────────

describe('bindStyleToMapInCode', () => {
  const CODE_WITH_STYLE = `export default function Page() {
  const cardData = [
    {"title":"Hello"},
    {"title":"World"},
  ];

  return (
    <div data-id="root">
      {cardData.map((item, idx) => (
        <div data-id="card" key={idx} style={{backgroundColor: '#ff0000', borderRadius: '8px'}}>
          <p>{item.title}</p>
        </div>
      ))}
    </div>
  );
}`;

  it('replaces inline style with iterator reference', () => {
    const result = bindStyleToMapInCode(CODE_WITH_STYLE, 'card', 'cardData', 'backgroundColor', 'backgroundColor', '#ff0000');
    expect(result).toContain('backgroundColor: item.backgroundColor');
    expect(result).not.toContain("backgroundColor: '#ff0000'");
  });

  it('adds field to all data items', () => {
    const result = bindStyleToMapInCode(CODE_WITH_STYLE, 'card', 'cardData', 'backgroundColor', 'bgColor', '#ff0000');
    const nodes = parseJSXToNodes(result);
    const root = nodes.get('root');
    expect(root!.inlineMapData![0].bgColor).toBe('#ff0000');
    expect(root!.inlineMapData![1].bgColor).toBe('#ff0000');
  });

  it('uses correct iterator variable name (not hardcoded "item")', () => {
    const codeWithPlan = CODE_WITH_STYLE.replace('(item, idx)', '(plan, idx)').replace('item.title', 'plan.title');
    const result = bindStyleToMapInCode(codeWithPlan, 'card', 'cardData', 'backgroundColor', 'bgColor', '#ff0000');
    expect(result).toContain('plan.bgColor');
    expect(result).not.toContain('item.bgColor');
  });

  it('only modifies template INSIDE .map() body', () => {
    const result = bindStyleToMapInCode(CODE_WITH_STYLE, 'card', 'cardData', 'backgroundColor', 'bgColor', '#ff0000');
    // The .map() should still be intact
    expect(result).toContain('cardData.map(');
    // Parse should succeed without errors
    const nodes = parseJSXToNodes(result);
    expect(nodes.size).toBeGreaterThan(0);
  });

  it('adds new property with binding when property does not exist in style block', () => {
    // 'background' does not exist in the template style — should be ADDED
    const result = bindStyleToMapInCode(CODE_WITH_STYLE, 'card', 'cardData', 'background', 'background', 'linear-gradient(red, blue)');
    // Should add the binding inside the style block (before inner })
    expect(result).toContain('background: item.background');
    // Original style properties should still be intact
    expect(result).toContain("backgroundColor: '#ff0000'");
    expect(result).toContain("borderRadius: '8px'");
    // The code should still parse without errors
    const nodes = parseJSXToNodes(result);
    expect(nodes.size).toBeGreaterThan(0);
    // Data should have the field added
    const root = nodes.get('root');
    expect(root!.inlineMapData![0].background).toBe('linear-gradient(red, blue)');
  });

  it('adds multiple new properties without breaking the style block', () => {
    // Simulate gradient text: add background, WebkitBackgroundClip, color
    let result = bindStyleToMapInCode(CODE_WITH_STYLE, 'card', 'cardData', 'background', 'background', 'linear-gradient(red, blue)');
    result = bindStyleToMapInCode(result, 'card', 'cardData', 'WebkitBackgroundClip', 'WebkitBackgroundClip', 'text');
    result = bindStyleToMapInCode(result, 'card', 'cardData', 'WebkitTextFillColor', 'WebkitTextFillColor', 'transparent');
    expect(result).toContain('background: item.background');
    expect(result).toContain('WebkitBackgroundClip: item.WebkitBackgroundClip');
    expect(result).toContain('WebkitTextFillColor: item.WebkitTextFillColor');
    // Should still parse
    const nodes = parseJSXToNodes(result);
    expect(nodes.size).toBeGreaterThan(0);
  });

  it('sequential bindings preserve all data fields across items', () => {
    // Bind 3 properties sequentially (background, WebkitBackgroundClip, color)
    // After each bind, code should still parse
    // All 3 bindings should appear in the style block AND data items
    let result = bindStyleToMapInCode(CODE_WITH_STYLE, 'card', 'cardData', 'background', 'bg', 'linear-gradient(red, blue)');
    let nodes = parseJSXToNodes(result);
    expect(nodes.size).toBeGreaterThan(0);
    expect(nodes.get('root')!.inlineMapData![0].bg).toBe('linear-gradient(red, blue)');
    expect(nodes.get('root')!.inlineMapData![1].bg).toBe('linear-gradient(red, blue)');

    result = bindStyleToMapInCode(result, 'card', 'cardData', 'WebkitBackgroundClip', 'clip', 'text');
    nodes = parseJSXToNodes(result);
    expect(nodes.size).toBeGreaterThan(0);
    // Previous field should still be present
    expect(nodes.get('root')!.inlineMapData![0].bg).toBe('linear-gradient(red, blue)');
    expect(nodes.get('root')!.inlineMapData![0].clip).toBe('text');

    result = bindStyleToMapInCode(result, 'card', 'cardData', 'color', 'textColor', 'transparent');
    nodes = parseJSXToNodes(result);
    expect(nodes.size).toBeGreaterThan(0);
    // All 3 fields should be present on both items
    const item0 = nodes.get('root')!.inlineMapData![0];
    const item1 = nodes.get('root')!.inlineMapData![1];
    expect(item0.bg).toBe('linear-gradient(red, blue)');
    expect(item0.clip).toBe('text');
    expect(item0.textColor).toBe('transparent');
    expect(item1.bg).toBe('linear-gradient(red, blue)');
    expect(item1.clip).toBe('text');
    expect(item1.textColor).toBe('transparent');
    // All 3 bindings in the style block
    expect(result).toContain('background: item.bg');
    expect(result).toContain('WebkitBackgroundClip: item.clip');
    expect(result).toContain('color: item.textColor');
  });

  it('replaces existing property then adds new property in same style block', () => {
    // First bind replaces an existing prop, second adds a new one
    let result = bindStyleToMapInCode(CODE_WITH_STYLE, 'card', 'cardData', 'backgroundColor', 'bgColor', '#ff0000');
    result = bindStyleToMapInCode(result, 'card', 'cardData', 'padding', 'pad', '16px');
    expect(result).toContain('backgroundColor: item.bgColor');
    expect(result).toContain('padding: item.pad');
    // borderRadius should remain untouched
    expect(result).toContain("borderRadius: '8px'");
    // Code should still be parseable
    const nodes = parseJSXToNodes(result);
    expect(nodes.size).toBeGreaterThan(0);
  });
});

// ─── getEnclosingMapParamsForNode ────────────────────────────────────────────

describe('getEnclosingMapParamsForNode', () => {
  it('returns both callback params for a two-param map (chained slice)', () => {
    const code = `{works.slice(0, 3).map((item, index) => <Card data-id="card" key={index} title={item.title} />)}`;
    expect(getEnclosingMapParamsForNode(code, 'card')).toEqual({ iterVar: 'item', indexVar: 'index' });
  });

  it('indexVar is null for the single-param form', () => {
    const code = `{works.map((item) => <Card data-id="card" title={item.title} />)}`;
    expect(getEnclosingMapParamsForNode(code, 'card')).toEqual({ iterVar: 'item', indexVar: null });
  });

  it('null when the node is outside any .map()', () => {
    const code = `<Card data-id="card" title="x" />`;
    expect(getEnclosingMapParamsForNode(code, 'card')).toBeNull();
  });
});

// ─── bindPropToMapInCode ──────────────────────────────────────────────────────

describe('bindPropToMapInCode', () => {
  const CODE_WITH_CODE_COMPONENT = `export default function Page() {
  const statData = [
    {"label":"Users"},
    {"label":"Revenue"},
  ];

  return (
    <div data-id="root">
      {statData.map((stat, idx) => (
        <div data-id="stat-card" key={idx}>
          <Counter data-id="stat-counter" endValue={500} suffix="+" />
          <p>{stat.label}</p>
        </div>
      ))}
    </div>
  );
}`;

  it('replaces static prop with iterator reference', () => {
    const result = bindPropToMapInCode(CODE_WITH_CODE_COMPONENT, 'stat-counter', 'statData', 'endValue', 'value', '500');
    expect(result).toContain('endValue={stat.value}');
    expect(result).not.toContain('endValue={500}');
  });

  it('uses correct iterator variable name', () => {
    const result = bindPropToMapInCode(CODE_WITH_CODE_COMPONENT, 'stat-counter', 'statData', 'endValue', 'value', '500');
    // Iterator is 'stat' from statData.map((stat, idx))
    expect(result).toContain('stat.value');
  });

  it('adds field to data array', () => {
    const result = bindPropToMapInCode(CODE_WITH_CODE_COMPONENT, 'stat-counter', 'statData', 'endValue', 'value', '500');
    expect(result).toContain('"value":"500"');
  });

  it('handles string prop values', () => {
    const result = bindPropToMapInCode(CODE_WITH_CODE_COMPONENT, 'stat-counter', 'statData', 'suffix', 'sfx', '+');
    expect(result).toContain('suffix={stat.sfx}');
  });

  it('INSERTS the prop when absent (component dropped into a list uses its default — no attr to rewrite)', () => {
    // `label` is NOT on the <Counter/> instance — it falls back to the component
    // default. Binding it must ADD `label={stat.label}` to the opening tag, not
    // no-op (the bug: "Set Variable" did nothing on a freshly dropped component).
    const result = bindPropToMapInCode(CODE_WITH_CODE_COMPONENT, 'stat-counter', 'statData', 'label', 'label', '');
    expect(result).toContain('label={stat.label}');
    // Inserted on the right instance (still self-closing, still has its other props).
    expect(result).toMatch(/<Counter data-id="stat-counter" label=\{stat\.label\} endValue=\{500\} suffix="\+" \/>/);
  });

  it('unbindPropFromMapInCode strips the bound prop attr (reverts to component default)', () => {
    const bound = bindPropToMapInCode(CODE_WITH_CODE_COMPONENT, 'stat-counter', 'statData', 'label', 'label', '');
    expect(bound).toContain('label={stat.label}');
    const unbound = unbindPropFromMapInCode(bound, 'stat-counter', 'label');
    expect(unbound).not.toContain('label={stat.label}');
    expect(unbound).toContain('endValue={500}');  // sibling props untouched
  });

  // ── WHOLE-VALUE image binding (urlWrap) ─────────────────────────────────────
  // An image prop whose master binds it BARE (`backgroundImage: coverImage`) —
  // the CMS field holds a plain URL, so the binding wraps at the instance:
  // `coverImage={`url(${item.coverImage})`}` (the Make Component / AboutPoint
  // convention).
  const CODE_WITH_IMAGE_PROP = `export default function Page() {
  const works = [
    {"coverImage":"https://pic/1.jpg"},
    {"coverImage":"https://pic/2.jpg"},
  ];

  return (
    <div data-id="root">
      {works.map((item, idx) => (
        <WorkCard data-id="card" key={idx} coverImage="url(https://picsum.photos/seed/x/1400/1000)" title="Neon" />
      ))}
    </div>
  );
}`;

  it('urlWrap: binds with the url() wrap at the binding site', () => {
    const result = bindPropToMapInCode(CODE_WITH_IMAGE_PROP, 'card', 'works', 'coverImage', 'coverImage', 'url(https://picsum.photos/seed/x/1400/1000)', true);
    expect(result).toContain('coverImage={`url(${item.coverImage})`}');
    expect(result).not.toContain('coverImage="url(');
  });

  it('urlWrap: seeds the data field UNWRAPPED (CMS fields hold plain urls)', () => {
    const result = bindPropToMapInCode(CODE_WITH_IMAGE_PROP, 'card', 'works', 'coverImage', 'cover2', 'url(https://picsum.photos/seed/x/1400/1000)', true);
    expect(result).toContain('"cover2":"https://picsum.photos/seed/x/1400/1000"');
    expect(result).not.toContain('"cover2":"url(');
  });

  it('urlWrap: REBINDS an existing whole-value binding without corrupting (template pattern runs before the generic one)', () => {
    const bound = bindPropToMapInCode(CODE_WITH_IMAGE_PROP, 'card', 'works', 'coverImage', 'coverImage', '', true);
    const rebound = bindPropToMapInCode(bound, 'card', 'works', 'coverImage', 'heroImage', '', true);
    expect(rebound).toContain('coverImage={`url(${item.heroImage})`}');
    expect(rebound).not.toContain('item.coverImage})`}');
    // the corruption shape the generic `[^}]+` pattern used to leave: a spliced
    // mid-template replacement with the old tail `)`}` dangling after it
    expect(rebound).not.toContain(')`})`}');
  });

  it('urlWrap: INSERTS the wrapped binding when the prop is absent', () => {
    const code = CODE_WITH_IMAGE_PROP.replace(' coverImage="url(https://picsum.photos/seed/x/1400/1000)"', '');
    const result = bindPropToMapInCode(code, 'card', 'works', 'coverImage', 'coverImage', '', true);
    expect(result).toContain('coverImage={`url(${item.coverImage})`}');
  });

  it('unbindPropFromMapInCode strips a whole-value template binding (nested ${} braces)', () => {
    const bound = bindPropToMapInCode(CODE_WITH_IMAGE_PROP, 'card', 'works', 'coverImage', 'coverImage', '', true);
    const unbound = unbindPropFromMapInCode(bound, 'card', 'coverImage');
    expect(unbound).not.toContain('coverImage={');
    expect(unbound).toContain('title="Neon"');  // sibling props untouched
  });

  it('does NOT cross-bind a shorter prop into a longer sibling (word boundary)', () => {
    // Two sibling props where one name is a substring-tail of the other:
    // binding `ergerg` must rewrite ITS attr, not `ergergerg` (whose tail is
    // "ergerg="). This was the user-reported bug: setting the color var
    // overrode the image var above it.
    const code = `export default function Page() {
  const teamData = [{"a":1}];
  return (<div data-id="root">{teamData.map((item, idx) => (
    <Card data-id="card" key={idx} ergergerg={item.image} ergerg="#fff" />
  ))}</div>);
}`;
    const out = bindPropToMapInCode(code, 'card', 'teamData', 'ergerg', 'color', '#fff');
    expect(out).toContain('ergergerg={item.image}');     // longer sibling UNTOUCHED
    expect(out).not.toContain('ergergerg={item.color}'); // never cross-bound
    expect(out).toMatch(/ ergerg=\{item\.color\}/);      // the correct (shorter) prop bound
  });
});

// ─── propagateToGhosts ───────────────────────────────────────────────────────

describe('propagateToGhosts', () => {
  beforeEach(() => {
    mockQueueMutation.mockClear();
  });

  it('propagates to ghosts that match oldVal', () => {
    const mapData: Record<string, string>[] = [
      { title: 'Original', desc: 'Template' },
      { title: 'Original', desc: 'Ghost 1' },
      { title: 'Original', desc: 'Ghost 2' },
    ];
    propagateToGhosts('cardData', 'title', 'Original', 'Updated', mapData);
    // Should queue mutations for items 1 and 2 (ghosts that match oldVal)
    expect(mockQueueMutation).toHaveBeenCalledTimes(2);
    expect(mockQueueMutation).toHaveBeenCalledWith({
      type: 'updateMapItem',
      varName: 'cardData',
      index: 1,
      item: { title: 'Updated', desc: 'Ghost 1' },
    });
    expect(mockQueueMutation).toHaveBeenCalledWith({
      type: 'updateMapItem',
      varName: 'cardData',
      index: 2,
      item: { title: 'Updated', desc: 'Ghost 2' },
    });
  });

  it('skips ghosts with different values (overridden)', () => {
    const mapData: Record<string, string>[] = [
      { title: 'Original', desc: 'Template' },
      { title: 'Custom Override', desc: 'Ghost 1' },  // overridden — different from oldVal
      { title: 'Original', desc: 'Ghost 2' },           // matches oldVal — should propagate
    ];
    propagateToGhosts('cardData', 'title', 'Original', 'Updated', mapData);
    // Only item 2 matches oldVal; item 1 has been overridden
    expect(mockQueueMutation).toHaveBeenCalledTimes(1);
    expect(mockQueueMutation).toHaveBeenCalledWith({
      type: 'updateMapItem',
      varName: 'cardData',
      index: 2,
      item: { title: 'Updated', desc: 'Ghost 2' },
    });
  });

  it('propagates to ghosts with undefined field values (inheriting)', () => {
    const mapData: Record<string, string>[] = [
      { title: 'Original', desc: 'Template', icon: 'star' },
      { title: 'Original', desc: 'Ghost 1' },  // icon is undefined → inheriting → should update
      { title: 'Original', desc: 'Ghost 2', icon: 'star' },  // icon matches oldVal → should update
      { title: 'Original', desc: 'Ghost 3', icon: 'custom' },  // icon overridden → skip
    ];
    propagateToGhosts('cardData', 'icon', 'star', 'heart', mapData);
    // Items 1 (undefined) and 2 (matches 'star') should be updated; item 3 is overridden
    expect(mockQueueMutation).toHaveBeenCalledTimes(2);
    expect(mockQueueMutation).toHaveBeenCalledWith({
      type: 'updateMapItem',
      varName: 'cardData',
      index: 1,
      item: { title: 'Original', desc: 'Ghost 1', icon: 'heart' },
    });
    expect(mockQueueMutation).toHaveBeenCalledWith({
      type: 'updateMapItem',
      varName: 'cardData',
      index: 2,
      item: { title: 'Original', desc: 'Ghost 2', icon: 'heart' },
    });
  });

  it('does not propagate to item 0 (template)', () => {
    const mapData: Record<string, string>[] = [
      { title: 'Original' },
      { title: 'Original' },
    ];
    propagateToGhosts('data', 'title', 'Original', 'New', mapData);
    // Should only affect index 1, never index 0
    expect(mockQueueMutation).toHaveBeenCalledTimes(1);
    expect(mockQueueMutation).toHaveBeenCalledWith(
      expect.objectContaining({ index: 1 }),
    );
  });

  it('handles single-item array (no ghosts)', () => {
    const mapData: Record<string, string>[] = [
      { title: 'Only Item' },
    ];
    propagateToGhosts('data', 'title', 'Only Item', 'New', mapData);
    // No ghosts to propagate to
    expect(mockQueueMutation).not.toHaveBeenCalled();
  });
});

// ─── Parser: binding detection ────────────────────────────────────────────────

describe('parser binding detection', () => {
  it('detects text bindings ({item.title})', () => {
    const nodes = parseJSXToNodes(CODE_WITH_MAP);
    // h3 and p children should have text bindings
    const card = nodes.get('card');
    expect(card!.isCollectionTemplate).toBe(true);
  });

  it('detects style bindings (style={{ bg: item.color }})', () => {
    const code = `export default function Page() {
  const data = [{"color":"red"}];
  return <div data-id="root">{data.map((item, idx) =>
    <div data-id="card" key={idx} style={{backgroundColor: item.color}}>text</div>
  )}</div>;
}`;
    const nodes = parseJSXToNodes(code);
    const card = nodes.get('card');
    expect(card).toBeDefined();
    expect(card!.styleBindings).toBeDefined();
    expect(card!.styleBindings!.length).toBe(1);
    expect(card!.styleBindings![0].styleProp).toBe('backgroundColor');
    expect(card!.styleBindings![0].field).toBe('color');
  });

  it('detects prop bindings (endValue={item.value})', () => {
    const code = `export default function Page() {
  const data = [{"value":"100"}];
  return <div data-id="root">{data.map((item, idx) =>
    <Counter data-id="ctr" key={idx} endValue={item.value} />
  )}</div>;
}`;
    const nodes = parseJSXToNodes(code);
    const ctr = nodes.get('ctr');
    expect(ctr).toBeDefined();
    expect(ctr!.propBindings).toBeDefined();
    expect(ctr!.propBindings!.length).toBe(1);
    expect(ctr!.propBindings![0].prop).toBe('endValue');
    expect(ctr!.propBindings![0].field).toBe('value');
  });

  it('detects multiple attribute bindings (src + alt on same element)', () => {
    const code = `export default function Page() {
  const data = [{"img":"https://example.com/photo.jpg","caption":"A photo"}];
  return <div data-id="root">{data.map((item, idx) =>
    <img data-id="photo" key={idx} src={item.img} alt={item.caption} />
  )}</div>;
}`;
    const nodes = parseJSXToNodes(code);
    const photo = nodes.get('photo');
    expect(photo).toBeDefined();
    expect(photo!.attrBindings).toBeDefined();
    expect(photo!.attrBindings!.length).toBe(2);
    const srcBinding = photo!.attrBindings!.find(b => b.property === 'src');
    const altBinding = photo!.attrBindings!.find(b => b.property === 'alt');
    expect(srcBinding).toBeDefined();
    expect(srcBinding!.field).toBe('img');
    expect(altBinding).toBeDefined();
    expect(altBinding!.field).toBe('caption');
  });

  it('isMapTemplateSelected: only true for template descendants, not siblings', () => {
    const code = `export default function Page() {
  const data = [{"title":"A"}];
  return <div data-id="root">
    <div data-id="container" style={{display: 'flex'}}>
      {data.map((item, idx) => <div data-id="tmpl" key={idx}>{item.title}</div>)}
      <div data-id="sibling">Static</div>
    </div>
  </div>;
}`;
    const nodes = parseJSXToNodes(code);
    const tmpl = nodes.get('tmpl');
    const sibling = nodes.get('sibling');
    expect(tmpl!.isCollectionTemplate).toBe(true);
    expect(sibling!.isCollectionTemplate).toBeFalsy();
  });

  it('detects map with custom iterator name', () => {
    const code = `export default function Page() {
  const plans = [{"name":"Free","price":"0"}];
  return <div data-id="root">{plans.map((plan, idx) =>
    <div data-id="plan-card" key={idx}>
      <h3>{plan.name}</h3>
      <span>{plan.price}</span>
    </div>
  )}</div>;
}`;
    const nodes = parseJSXToNodes(code);
    const root = nodes.get('root');
    expect(root!.collectionList).toBeDefined();
    expect(root!.collectionList!.itemVar).toBe('plan');
    expect(root!.collectionList!.source).toBe('__inline:plans');
  });
});

// ─── bindToCmsCollectionInCode ────────────────────────────────────────────────
//
// Non-regression tests for the CMS-backed `.map()` wrap. The chain is
// generator → parser → renderer; a passing parser assertion proves the
// generated JSX is in the exact shape the renderer's ghost loop expects.

describe('bindToCmsCollectionInCode', () => {
  const SIMPLE_PAGE = `export default function Page() {
  return (
    <div data-id="root">
      <div data-id="card1">
        <h3 data-id="t">Hello</h3>
      </div>
    </div>
  );
}`;

  it('wraps the selected element in a .map() bound to the collection', () => {
    const result = bindToCmsCollectionInCode(SIMPLE_PAGE, 'card1', 'blog');
    expect(result).toContain("import blog from '@/cms/blog.json';");
    expect(result).toContain('blog.map((item, idx) => (');
    expect(result).toContain('data-id="card1" key={idx}');
    // Original child stays intact — bindings are added later by the user.
    expect(result).toContain('<h3 data-id="t">Hello</h3>');
  });

  it('produces JSX the parser detects as a CMS collectionList', () => {
    const result = bindToCmsCollectionInCode(SIMPLE_PAGE, 'card1', 'blog');
    const nodes = parseJSXToNodes(result);
    const root = nodes.get('root');
    expect(root?.collectionList).toBeDefined();
    expect(root!.collectionList!.source).toBe('blog');
    expect(root!.collectionList!.itemVar).toBe('item');
    expect(root!.collectionList!.templateIds.default).toBe('card1');
  });

  it('camelCases hyphenated slugs for the import variable', () => {
    const result = bindToCmsCollectionInCode(SIMPLE_PAGE, 'card1', 'team-members');
    expect(result).toContain("import teamMembers from '@/cms/team-members.json';");
    expect(result).toContain('teamMembers.map((item, idx) => (');
  });

  it('does NOT duplicate the import when re-binding the same collection', () => {
    const once = bindToCmsCollectionInCode(SIMPLE_PAGE, 'card1', 'blog');
    // Pretend the user wraps a sibling against the same collection — no
    // second `import blog ...` should appear in the output.
    const PAGE_WITH_SIBLING = once.replace(
      '<div data-id="root">',
      '<div data-id="root"><div data-id="card2"><h3 data-id="t2">B</h3></div>',
    );
    const twice = bindToCmsCollectionInCode(PAGE_WITH_SIBLING, 'card2', 'blog');
    const importCount = (twice.match(/from '@\/cms\/blog\.json'/g) || []).length;
    expect(importCount).toBe(1);
  });

  it('inserts the new import after existing imports rather than at line 0', () => {
    const code = `import React from 'react';
import { motion } from 'framer-motion';

export default function Page() {
  return <div data-id="root"><div data-id="card1">x</div></div>;
}`;
    const result = bindToCmsCollectionInCode(code, 'card1', 'blog');
    // Imports stay together: react → motion → blog, in that order, with no
    // gap between them.
    const reactIdx = result.indexOf("from 'react'");
    const motionIdx = result.indexOf("from 'framer-motion'");
    const blogIdx = result.indexOf("from '@/cms/blog.json'");
    expect(reactIdx).toBeGreaterThanOrEqual(0);
    expect(motionIdx).toBeGreaterThan(reactIdx);
    expect(blogIdx).toBeGreaterThan(motionIdx);
  });

  it('returns the original code unchanged when the nodeId is not found', () => {
    const result = bindToCmsCollectionInCode(SIMPLE_PAGE, 'does-not-exist', 'blog');
    expect(result).toBe(SIMPLE_PAGE);
  });
});

// ─── unbindFromCmsCollectionInCode ────────────────────────────────────────────
//
// Bind → unbind round-trip: the unwrap should leave the source structurally
// identical to what bindToCmsCollectionInCode received (the import line is
// kept on purpose — see the generator's doc comment).

describe('unbindFromCmsCollectionInCode', () => {
  const SIMPLE_PAGE = `export default function Page() {
  return (
    <div data-id="root">
      <div data-id="card1">
        <h3 data-id="t">Hello</h3>
      </div>
    </div>
  );
}`;

  it('round-trips: bind then unbind restores the original element shape', () => {
    const bound = bindToCmsCollectionInCode(SIMPLE_PAGE, 'card1', 'blog');
    const unbound = unbindFromCmsCollectionInCode(bound, 'card1');
    // No more `.map(` and no `key={idx}` attribute leftover.
    expect(unbound).not.toContain('.map(');
    expect(unbound).not.toContain('key={idx}');
    // The element body survives intact.
    expect(unbound).toContain('<div data-id="card1">');
    expect(unbound).toContain('<h3 data-id="t">Hello</h3>');
  });

  it('produces JSX the parser no longer reports as a CMS collectionList', () => {
    const bound = bindToCmsCollectionInCode(SIMPLE_PAGE, 'card1', 'blog');
    const unbound = unbindFromCmsCollectionInCode(bound, 'card1');
    const nodes = parseJSXToNodes(unbound);
    const root = nodes.get('root');
    expect(root?.collectionList).toBeUndefined();
    const card = nodes.get('card1');
    expect(card?.isCollectionTemplate).toBeUndefined();
  });

  it('returns code unchanged when no map wrapper precedes the element', () => {
    // Plain unbound page — calling unbind is a no-op.
    const result = unbindFromCmsCollectionInCode(SIMPLE_PAGE, 'card1');
    expect(result).toBe(SIMPLE_PAGE);
  });

  it('returns code unchanged when the nodeId is not found', () => {
    const bound = bindToCmsCollectionInCode(SIMPLE_PAGE, 'card1', 'blog');
    const result = unbindFromCmsCollectionInCode(bound, 'does-not-exist');
    expect(result).toBe(bound);
  });
});

// ─── changeCollectionSourceInCode ─────────────────────────────────────────────
//
// Repoint a CMS-bound `.map()` to a different collection. Verify the import
// AND the iterator var name swap together — getting only one out the door
// would leave the file in an unparseable state.

describe('changeCollectionSourceInCode', () => {
  const PAGE_BOUND_TO_BLOG = `import blog from '@/cms/blog.json';

export default function Page() {
  return (
    <div data-id="root">
      {blog.map((item, idx) => (
        <div data-id="card1" key={idx}>{item.title}</div>
      ))}
    </div>
  );
}`;

  it('rewrites the .map() iterator and the import together', () => {
    const result = changeCollectionSourceInCode(PAGE_BOUND_TO_BLOG, 'root', 'team-members');
    // New import + new var name on the .map() head.
    expect(result).toContain("import teamMembers from '@/cms/team-members.json';");
    expect(result).toContain('teamMembers.map((item, idx) => (');
    // Old import + old var gone.
    expect(result).not.toContain("import blog from '@/cms/blog.json'");
    expect(result).not.toMatch(/\bblog\.map\(/);
  });

  it('preserves field references inside the template — re-binding is the user\'s job', () => {
    const result = changeCollectionSourceInCode(PAGE_BOUND_TO_BLOG, 'root', 'team');
    // {item.title} is left as-is. If `team` doesn't have a `title` field
    // the binding will resolve to undefined at render — that's a standard
    // compromise documented in the generator's doc comment.
    expect(result).toContain('{item.title}');
  });

  it('returns code unchanged when the parent nodeId is not found', () => {
    const result = changeCollectionSourceInCode(PAGE_BOUND_TO_BLOG, 'does-not-exist', 'team');
    expect(result).toBe(PAGE_BOUND_TO_BLOG);
  });

  it('rewrites the slug inside a RESPONSIVE-upgraded __applyListConfig head — regression', () => {
    // A list with per-viewport/variant overrides is `__applyListConfig(slug, cfg).map()`;
    // findCollectionChainHead returns null on it, so source change used to no-op.
    const upgraded = `import blog from '@/cms/blog.json';
export default function Page() {
  const listCfgRoot = useResponsiveListConfig({}, { 768: { sort: [{ field: 'title', direction: 'asc' }] } }, [768], undefined, {});
  return (
    <div data-id="root">
      {__applyListConfig(blog, listCfgRoot).map((item, idx) => (
        <div data-id="card1" key={idx}>{item.title}</div>
      ))}
    </div>
  );
}`;
    const result = changeCollectionSourceInCode(upgraded, 'root', 'team');
    expect(result).toContain('__applyListConfig(team, listCfgRoot)');
    expect(result).not.toContain('__applyListConfig(blog,');
    expect(result).toContain("import team from '@/cms/team.json';");
    expect(result).not.toContain("import blog from '@/cms/blog.json'");
  });

  it('drops the orphan old import when the new import already exists', () => {
    const codeWithBoth = PAGE_BOUND_TO_BLOG.replace(
      "import blog from '@/cms/blog.json';",
      "import blog from '@/cms/blog.json';\nimport team from '@/cms/team.json';",
    );
    const result = changeCollectionSourceInCode(codeWithBoth, 'root', 'team');
    // Old import gone, new import present exactly once.
    expect(result).not.toContain("import blog from '@/cms/blog.json'");
    const imports = result.match(/import team from '@\/cms\/team\.json'/g) || [];
    expect(imports.length).toBe(1);
  });

  it('rewrites field references when fieldRemap is provided', () => {
    const code = `import blog from '@/cms/blog.json';

export default function Page() {
  return (
    <div data-id="root">
      {blog.map((item, idx) => (
        <div data-id="card1" key={idx} style={{ backgroundImage: \`url(\${item.cover})\` }}>
          <h3 data-id="t">{item.title}</h3>
        </div>
      ))}
    </div>
  );
}`;
    const result = changeCollectionSourceInCode(code, 'root', 'team', {
      title: 'name',
      cover: 'photo',
    });
    // References inside the .map() body are rewritten to the new field names.
    expect(result).toContain('{item.name}');
    expect(result).toContain('url(${item.photo})');
    // Old field names gone from the body.
    expect(result).not.toContain('item.title');
    expect(result).not.toContain('item.cover');
  });

  it('leaves field references alone when no remap entry exists for them', () => {
    // Caller passes only a partial map — `cover` has no entry. The
    // generator MUST leave `item.cover` as-is (rather than erasing it),
    // so the user can rebind manually.
    const code = `import blog from '@/cms/blog.json';

export default function Page() {
  return (
    <div data-id="root">
      {blog.map((item, idx) => (
        <div data-id="card1" key={idx}>{item.title} {item.cover}</div>
      ))}
    </div>
  );
}`;
    const result = changeCollectionSourceInCode(code, 'root', 'team', { title: 'name' });
    expect(result).toContain('{item.name}');
    expect(result).toContain('{item.cover}'); // untouched
  });

  // ─── Previously-broken shapes (the user's "source change does nothing") ──────

  it('repoints a list that has a .filter().sort().slice() CHAIN before .map() (chain preserved)', () => {
    const CHAINED = `import blog from '@/cms/blog.json';
export default function Page() {
  return (
    <div data-id="root">
      {blog.filter(item => item.featured === true).sort((a, b) => a.title > b.title ? 1 : -1).slice(0, 3).map((item, idx) => (
        <div data-id="card1" key={idx}>{item.title}</div>
      ))}
    </div>
  );
}`;
    const result = changeCollectionSourceInCode(CHAINED, 'root', 'team');
    expect(result).toContain("import team from '@/cms/team.json';");
    // Only the chain HEAD is repointed; the chain stays intact.
    expect(result).toContain('team.filter(item => item.featured === true).sort');
    expect(result).toContain('.slice(0, 3).map((item, idx) => (');
    expect(result).not.toMatch(/\bblog\.filter\b/);
    expect(result).not.toContain("import blog from '@/cms/blog.json'");
  });

  it('repoints a SINGLE-arg `item =>` map (no idx param)', () => {
    const SINGLE_ARG = `import blog from '@/cms/blog.json';
export default function Page() {
  return (
    <div data-id="root">
      {blog.map(item => <div data-id="card1">{item.title}</div>)}
    </div>
  );
}`;
    const result = changeCollectionSourceInCode(SINGLE_ARG, 'root', 'team');
    expect(result).toContain("import team from '@/cms/team.json';");
    expect(result).toContain('team.map(item =>');
    expect(result).not.toMatch(/\bblog\.map\(/);
  });

  it('repoints a collection list living in the `const canvasNodes` fragment', () => {
    const CANVAS_NODE_LIST = `import blog from '@/cms/blog.json';
export default function Page() {
  return <div data-id="root"></div>;
}
const canvasNodes = <>
  <div data-id="blogs-cn" data-canvas-node="true">
    {blog.map((item, idx) => (
      <div data-id="card1" key={idx}>{item.title}</div>
    ))}
  </div>
</>;`;
    const result = changeCollectionSourceInCode(CANVAS_NODE_LIST, 'blogs-cn', 'team');
    expect(result).toContain("import team from '@/cms/team.json';");
    expect(result).toContain('team.map((item, idx) => (');
    expect(result).not.toMatch(/\bblog\.map\(/);
  });

  it('repoints + remaps fields on the CHAINED shape together', () => {
    const CHAINED = `import blog from '@/cms/blog.json';
export default function Page() {
  return (
    <div data-id="root">
      {blog.slice(0, 5).map((item, idx) => (
        <div data-id="card1" key={idx}>{item.title}</div>
      ))}
    </div>
  );
}`;
    const result = changeCollectionSourceInCode(CHAINED, 'root', 'team', { title: 'name' });
    expect(result).toContain('team.slice(0, 5).map((item, idx) => (');
    expect(result).toContain('{item.name}');
    expect(result).not.toContain('{item.title}');
  });

  it('repoints the row CMS-nav Link route to the new collection (/blog/:slug → /team/:slug)', () => {
    const WITH_NAV = `import blog from '@/cms/blog.json';
import Link from 'next/link';
export default function Page() {
  return (
    <div data-id="root">
      {blog.map((item, idx) => (
        <Link data-cms-nav="row" href={\`/blog/\${item?._slug ?? ''}\`} data-id="card1" key={idx}>{item.title}</Link>
      ))}
    </div>
  );
}`;
    const result = changeCollectionSourceInCode(WITH_NAV, 'root', 'team');
    expect(result).toContain("href={`/team/${item?._slug ?? ''}`}");
    expect(result).not.toContain('/blog/${item');
  });
});

// ─── bindCmsNavLinkOnDropInCode ─────────────────────────────────────────────

describe('bindCmsNavLinkOnDropInCode', () => {
  // The drop lands a native <a> (so the drag strategy doesn't component-
  // import it); this pass rewrites it to a <Link>.
  const DETAIL_CODE = `import React from 'react';
import collection32 from '@/cms/collection-3-2.json';

export default function Page() {
  const params = useParams();
  const item = collection32.find((i) => i._slug === params?.slug) ?? collection32[0];
  return (
    <div data-id="root">
      <a data-id="nav-1" data-cms-nav="next" data-cms-collection="collection-3-2" href="#">Next →</a>
    </div>
  );
}`;

  it('rewrites the <a> to a <Link> with the resolved href', () => {
    const out = bindCmsNavLinkOnDropInCode(DETAIL_CODE, 'nav-1');
    expect(out).toContain('<Link data-id="nav-1"');
    expect(out).toContain('>Next →</Link>');
    expect(out).toContain('href={`/collection-3-2/${collection32[collection32.findIndex');
    expect(out).toContain('params?.slug) + 1]?._slug');
  });

  it('keeps data-cms-nav, strips the collection hint + placeholder href', () => {
    const out = bindCmsNavLinkOnDropInCode(DETAIL_CODE, 'nav-1');
    // data-cms-nav is the persistent marker the Link tool reads back.
    expect(out).toContain('data-cms-nav="next"');
    expect(out).not.toContain('data-cms-collection');
    expect(out).not.toContain('href="#"');
    expect(out).not.toContain('</a>');
  });

  it('uses a -1 offset for a prev link', () => {
    const prevCode = DETAIL_CODE.replace('data-cms-nav="next"', 'data-cms-nav="prev"');
    const out = bindCmsNavLinkOnDropInCode(prevCode, 'nav-1');
    expect(out).toContain('params?.slug) - 1]?._slug');
  });

  it('leaves the code unchanged when the node id is not found', () => {
    expect(bindCmsNavLinkOnDropInCode(DETAIL_CODE, 'ghost')).toBe(DETAIL_CODE);
  });

  it('leaves the code unchanged when there is no detail-page item', () => {
    const noItem = DETAIL_CODE.replace(/const item = .*/, 'const item = null;');
    expect(bindCmsNavLinkOnDropInCode(noItem, 'nav-1')).toBe(noItem);
  });
});

// ─── setCmsNavHrefInCode (Link tool "Slug" control) ─────────────────────────

describe('setCmsNavHrefInCode', () => {
  const PAGE = `import collection32 from '@/cms/collection-3-2.json';
export default function Page() {
  const params = useParams();
  const item = collection32.find((i) => i._slug === params?.slug) ?? collection32[0];
  return (
    <div data-id="root">
      <Link data-id="link-1" href="#">Read</Link>
    </div>
  );
}`;

  it('binds a next nav href + marker', () => {
    const out = setCmsNavHrefInCode(PAGE, 'link-1', 'next', 'collection-3-2');
    expect(out).toContain('data-cms-nav="next"');
    expect(out).toContain('href={`/collection-3-2/${collection32[collection32.findIndex');
    expect(out).toContain('params?.slug) + 1]?._slug');
  });

  it('uses a -1 offset for prev', () => {
    const out = setCmsNavHrefInCode(PAGE, 'link-1', 'prev', 'collection-3-2');
    expect(out).toContain('data-cms-nav="prev"');
    expect(out).toContain('params?.slug) - 1]?._slug');
  });

  it('binds the current item (self) — params.slug, no collection var', () => {
    const out = setCmsNavHrefInCode(PAGE, 'link-1', 'self', 'collection-3-2');
    expect(out).toContain('data-cms-nav="self"');
    expect(out).toContain("href={`/collection-3-2/${params?.slug ?? ''}`}");
  });

  it('clears the binding on mode "none"', () => {
    const bound = setCmsNavHrefInCode(PAGE, 'link-1', 'next', 'collection-3-2');
    const cleared = setCmsNavHrefInCode(bound, 'link-1', 'none', 'collection-3-2');
    expect(cleared).not.toContain('data-cms-nav');
    expect(cleared).not.toContain('href=');
  });

  it('replaces an existing expression href when the mode flips', () => {
    const next = setCmsNavHrefInCode(PAGE, 'link-1', 'next', 'collection-3-2');
    const prev = setCmsNavHrefInCode(next, 'link-1', 'prev', 'collection-3-2');
    // Exactly one href + one marker — the old expression href was removed.
    expect(prev.match(/data-cms-nav=/g)?.length).toBe(1);
    expect(prev.match(/href=/g)?.length).toBe(1);
    expect(prev).toContain('params?.slug) - 1]?._slug');
    expect(prev).not.toContain('+ 1]?._slug');
  });

  it('leaves the code unchanged when the node id is not found', () => {
    expect(setCmsNavHrefInCode(PAGE, 'ghost', 'next', 'collection-3-2')).toBe(PAGE);
  });

  // 'row' mode — picks the slug from the wrapping `.map((item) => …)`
  // iterator var. Used by the Link tool when the link lives inside a
  // CMS-backed map on a regular (non-detail) page. Each rendered row
  // resolves its own URL.
  it('binds row mode using the map iterator var', () => {
    const MAP_PAGE = `import collection32 from '@/cms/collection-3-2.json';
export default function Page() {
  return (
    <div data-id="root">
      {collection32.map((item, idx) => (
        <div data-id="row-1" key={idx}>
          <Link data-id="link-1" href="#">Read</Link>
        </div>
      ))}
    </div>
  );
}`;
    const out = setCmsNavHrefInCode(MAP_PAGE, 'link-1', 'row', 'collection-3-2', 'item');
    expect(out).toContain('data-cms-nav="row"');
    expect(out).toContain("href={`/collection-3-2/${item?._slug ?? ''}`}");
    // Should NOT use detail-page constructs.
    expect(out).not.toContain('params?.slug');
    expect(out).not.toContain('findIndex');
  });

  it('row mode respects a custom iterator var (post / entry / etc.)', () => {
    const POST_PAGE = `import collection32 from '@/cms/collection-3-2.json';
export default function Page() {
  return (
    <div data-id="root">
      {collection32.map((post, idx) => (
        <div data-id="row-1" key={idx}>
          <Link data-id="link-1" href="#">Read</Link>
        </div>
      ))}
    </div>
  );
}`;
    const out = setCmsNavHrefInCode(POST_PAGE, 'link-1', 'row', 'collection-3-2', 'post');
    expect(out).toContain("href={`/collection-3-2/${post?._slug ?? ''}`}");
  });

  it('clears a row binding on mode "none"', () => {
    const MAP_PAGE = `import collection32 from '@/cms/collection-3-2.json';
export default function Page() {
  return (
    <div data-id="root">
      {collection32.map((item) => (
        <Link data-id="link-1" href="#">Read</Link>
      ))}
    </div>
  );
}`;
    const bound = setCmsNavHrefInCode(MAP_PAGE, 'link-1', 'row', 'collection-3-2', 'item');
    expect(bound).toContain('data-cms-nav="row"');
    const cleared = setCmsNavHrefInCode(bound, 'link-1', 'none', 'collection-3-2');
    expect(cleared).not.toContain('data-cms-nav');
    expect(cleared).not.toContain('href=');
  });
});

// ─── Hyphenated slug + the <style>-block selector trap ───────────────────────
//
// User report 2026-08-08: binding a component instance's props to CMS fields
// inside a collection list "applied nothing". It wrote the attributes into a
// CSS SELECTOR instead:
//
//   [data-id="RoJiKu-msk6g4hq-2" content1={item.untitled} content={item.title}]::after
//
// Two defects compounding: callers pass the SLUG (`collection-1`) while the
// array is imported camel-cased (`collection1`), so `<varName>.map(` missed and
// the "search inside the map body" offset fell back to 0 — where the page's
// <style> block sits, ahead of the JSX.

describe('CMS binding — hyphenated slug and the style-block selector', () => {
  /** The reported page shape: a border-overlay rule for the instance sits in a
   *  <style> block ABOVE the .map(), and the import is camel-cased. */
  const pageWithStyleBlock = (attrs = '') => `import collection1 from '@/cms/collection-1.json';
export default function Page() {
  return <div data-id="root">
    <style>{\`
    [data-id="RoJiKu-1"${attrs}]::after {
      content: '';
      border-width: 1px;
    }
    \`}</style>
    <div data-id="list">
      {collection1.map((item, idx) => <Link data-id="row-1" key={idx}>
        <RoJiKu data-id="RoJiKu-1" data-name="Frame" style={{ order: '0' }}></RoJiKu>
      </Link>)}
    </div>
  </div>;
}`;

  it('binds the prop on the JSX tag, not into the CSS selector', () => {
    const out = bindPropToMapInCode(pageWithStyleBlock(), 'RoJiKu-1', 'collection-1', 'content', 'title', '');
    expect(out).toContain('<RoJiKu data-id="RoJiKu-1" content={item.title}');
    // The selector is untouched — its border rule still paints.
    expect(out).toContain('[data-id="RoJiKu-1"]::after');
    expect(out).not.toMatch(/\[data-id="RoJiKu-1"[^\]]*content=/);
  });

  it('resolves the camel-cased import so the iterator is read from the real .map()', () => {
    const renamed = pageWithStyleBlock().replace(/\bitem\b/g, 'faq');
    const out = bindPropToMapInCode(renamed, 'RoJiKu-1', 'collection-1', 'content', 'title', '');
    // `item` would be the blind fallback; the real iterator here is `faq`.
    expect(out).toContain('content={faq.title}');
  });

  it('a slug that already IS the identifier still works (no regression)', () => {
    const plain = `import blog from '@/cms/blog.json';
export default function Page() {
  return <div data-id="root">{blog.map((item, idx) => <Card data-id="c-1" key={idx} />)}</div>;
}`;
    const out = bindPropToMapInCode(plain, 'c-1', 'blog', 'title', 'heading', '');
    expect(out).toContain('title={item.heading}');
  });

  it('binding a STYLE inside a hyphenated collection lands in the JSX too', () => {
    const out = bindStyleToMapInCode(pageWithStyleBlock(), 'RoJiKu-1', 'collection-1', 'order', 'rank', '0');
    expect(out).toContain('[data-id="RoJiKu-1"]::after');
    expect(out).toContain('order: item.rank');
  });

  it('unbind finds the JSX occurrence, not the selector', () => {
    const bound = pageWithStyleBlock().replace(
      '<RoJiKu data-id="RoJiKu-1"',
      '<RoJiKu data-id="RoJiKu-1" content={item.title}',
    );
    const out = unbindPropFromMapInCode(bound, 'RoJiKu-1', 'content');
    expect(out).not.toContain('content={item.title}');
    expect(out).toContain('[data-id="RoJiKu-1"]::after');
  });
});
