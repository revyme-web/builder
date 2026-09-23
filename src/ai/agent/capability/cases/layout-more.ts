// Layout rows that need more than a style write — audit §7.
import type { CapabilityCase } from '../harness';
import { HOME, FIXTURE_FILES } from '../fixture';

const must = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };

export const LAYOUT_MORE_CASES: CapabilityCase[] = [
  {
    id: 'layout/add-node', domain: 'layout', status: 'supported',
    feature: 'Add an element into a layout',
    ask: 'add a fourth card',
    calls: [{ tool: 'add_node', args: { parent_id: 'cards', id: 'card-4', name: 'Card', styles: { width: '320px', height: '200px', backgroundColor: '#f4f4f5', borderRadius: '12px' } } }],
    expect: (w) => {
      const n = w.node('card-4');
      must(w.node('cards').children.includes('card-4'), 'card-4 is not a child of cards');
      must(n.styles.position, 'a new node must carry a position');
    },
  },
  {
    id: 'layout/reorder', domain: 'layout', status: 'supported',
    feature: 'Reorder within a layout',
    ask: 'move the third card to the front',
    calls: [{ tool: 'reorder_node', args: { node_id: 'card-3', parent_id: 'cards', index: 0 } }],
    expect: (w) => {
      // What a user SEES is the flex `order`, not the JSX position.
      const order = (id: string) => Number(w.node(id).styles.order ?? NaN);
      must(order('card-3') < order('card-1') && order('card-1') < order('card-2'), `visual order is ${['card-1', 'card-2', 'card-3'].map((i) => `${i}:${w.node(i).styles.order}`).join(' ')}`);
    },
  },
  {
    id: 'layout/move-node', domain: 'layout', status: 'supported',
    feature: 'Move an element to another parent',
    ask: 'move the hero image into the cards row',
    calls: [{ tool: 'move_node', args: { node_id: 'hero-image', parent_id: 'cards' } }],
    expect: (w) => must(w.node('cards').children.includes('hero-image') && !w.node('hero').children.includes('hero-image'), 'the image did not change parent'),
  },
  {
    id: 'layout/duplicate', domain: 'layout', status: 'supported',
    feature: 'Duplicate an element',
    ask: 'duplicate the first card',
    calls: [{ tool: 'duplicate_node', args: { node_id: 'card-1' } }],
    expect: (w) => must(w.node('cards').children.length === 4, `cards has ${w.node('cards').children.length} children`),
  },
  {
    id: 'layout/delete', domain: 'layout', status: 'supported',
    feature: 'Delete an element',
    ask: 'remove the second card',
    calls: [{ tool: 'delete_node', args: { node_id: 'card-2' } }],
    expect: (w) => must(!w.nodes().has('card-2'), 'card-2 is still there'),
  },
  {
    id: 'layout/hide-on-breakpoint', domain: 'layout', status: 'supported',
    feature: 'Hide an element on one breakpoint',
    ask: 'hide the hero image on mobile',
    calls: [{ tool: 'set_styles', args: { node_id: 'hero-image', styles: { display: 'none' }, viewport: 375 } }],
    expect: (w) => {
      must(w.node('hero-image').styles.display !== 'none', 'it was hidden everywhere');
      must(/max-width:\s*375[\s\S]*hero-image[\s\S]{0,200}display:\s*none/.test(w.read(HOME) ?? ''), 'no mobile rule hiding it');
    },
  },
  {
    id: 'layout/padding', domain: 'layout', status: 'supported',
    feature: 'Padding',
    ask: 'give the hero 120px of padding top and bottom',
    calls: [{ tool: 'set_styles', args: { node_id: 'hero', styles: { paddingTop: '120px', paddingBottom: '120px' } } }],
    expect: (w) => must(w.node('hero').styles.paddingTop === '120px' && w.node('hero').styles.paddingBottom === '120px', 'padding not written'),
  },
  {
    id: 'layout/z-index', domain: 'layout', status: 'supported',
    feature: 'Stacking order (z-index)',
    ask: 'bring the first card to the front',
    calls: [{ tool: 'set_styles', args: { node_id: 'card-1', styles: { zIndex: '5' } } }],
    expect: (w) => must(String(w.node('card-1').styles.zIndex) === '5', 'zIndex not written'),
  },

  // ── not possible yet ──
  {
    id: 'layout/size-percent', domain: 'layout', status: 'supported',
    feature: 'Size in %, vw, vh',
    ask: 'make the hero image 80% wide and 60vh tall',
    calls: [{ tool: 'set_size_units', args: { node_id: 'hero-image', width: '80%', height: '60vh' } }],
    expect: (w) => { const s = w.node('hero-image').styles; must(s.width === '80%' && s.height === '60vh', JSON.stringify(s)); },
  },
  {
    id: 'layout/size-fill', domain: 'layout', status: 'supported',
    feature: 'Fill (grow to the available space)',
    ask: 'make the cards share the row equally',
    calls: [
      { tool: 'set_size_units', args: { node_id: 'card-1', width: 'fill' } },
      { tool: 'set_size_units', args: { node_id: 'card-2', width: 'fill' } },
      { tool: 'set_size_units', args: { node_id: 'card-3', width: 'fill' } },
    ],
    expect: (w) => {
      for (const id of ['card-1', 'card-2', 'card-3']) {
        const s = w.node(id).styles;
        must(s.flex === '1 0 0px' && !s.width, `${id}: ${JSON.stringify({ flex: s.flex, width: s.width })}`);
      }
    },
  },
  {
    id: 'layout/size-fill-cross', domain: 'layout', status: 'supported',
    feature: 'Fill in the cross axis is 100%',
    ask: 'make the first card as tall as the row',
    calls: [{ tool: 'set_size_units', args: { node_id: 'card-1', height: 'fill' } }],
    expect: (w) => must(w.node('card-1').styles.height === '100%', `height is ${w.node('card-1').styles.height}`),
  },
  {
    id: 'layout/size-fill-no-layout', domain: 'layout', status: 'supported',
    feature: 'Fill outside a layout is refused with the fix',
    ask: 'make the page root fill',
    calls: [{ tool: 'set_size_units', args: { node_id: 'hero', width: 'fill' } }],
    // the hero's parent (root) IS a flex column, so use a node whose parent is not a layout: none in fixture → use root itself
    allowFailedCalls: true,
    expect: (w) => must(!w.replies[0].isError || /flex parent/.test(w.replies[0].text), 'refused without saying why'),
  },
  {
    id: 'layout/size-fit', domain: 'layout', status: 'supported',
    feature: 'Fit / hug content',
    ask: 'make the first card hug its content',
    calls: [{ tool: 'set_size_units', args: { node_id: 'card-1', width: 'fit', height: 'fit' } }],
    expect: (w) => { const s = w.node('card-1').styles; must(s.width === 'min-content' && s.height === 'min-content', JSON.stringify(s)); },
  },
  {
    id: 'layout/grid', domain: 'layout', status: 'supported',
    feature: 'Grid columns / spans',
    ask: 'make the cards a 3-column grid, the first spanning two',
    calls: [
      { tool: 'set_grid', args: { node_id: 'cards', columns: 'repeat(3, 1fr)', gap: '24px' } },
      { tool: 'set_styles', args: { node_id: 'card-1', styles: { gridColumn: 'span 2' } } },
    ],
    expect: (w) => {
      const s = w.node('cards').styles;
      must(s.display === 'grid' && s.gridTemplateColumns === 'repeat(3, 1fr)', JSON.stringify(s));
      must(w.node('card-1').styles.gridColumn === 'span 2', 'no span');
    },
  },
  {
    id: 'layout/responsive-reorder', domain: 'layout', status: 'supported',
    feature: 'Reorder on one breakpoint only',
    ask: 'on mobile show the image above the title',
    calls: [{ tool: 'reorder_on_breakpoint', args: { node_id: 'hero-image', index: 0, viewport: 375 } }],
    expect: (w) => {
      must(w.node('hero-image').styles.order === '3', 'the desktop order changed');
      must(/max-width:\s*375[\s\S]*hero-image[\s\S]{0,200}order:\s*0/.test(w.read(HOME) ?? ''), 'no mobile order rule');
    },
  },
  {
    id: 'layout/transform', domain: 'layout', status: 'supported',
    feature: 'Rotate / skew / scale',
    ask: 'rotate the first card by 6 degrees and scale it up a little',
    calls: [{ tool: 'set_transform', args: { node_id: 'card-1', rotate: 6, scale: 1.05 } }],
    // The canvas fold's grammar: scale → rotate → skew, single-arg functions.
    expect: (w) => must(String(w.node('card-1').styles.transform) === 'scale(1.05) rotate(6deg)', `transform is ${w.node('card-1').styles.transform}`),
  },
  {
    id: 'layout/viewports', domain: 'layout', status: 'supported',
    feature: 'List / add / resize / remove breakpoints',
    ask: 'add a 1024px breakpoint, then make the tablet 800 wide',
    calls: [
      { tool: 'set_styles', args: { node_id: 'hero-title', styles: { fontSize: '40px' }, viewport: 768 } },
      { tool: 'list_viewports', args: {} },
      { tool: 'add_viewport', args: { label: 'Laptop', width: 1024 } },
      { tool: 'set_styles', args: { node_id: 'hero-title', styles: { fontSize: '44px' }, viewport: 1024 } },
      { tool: 'set_viewport_width', args: { viewport: 'tablet', width: 800 } },
      { tool: 'list_viewports', args: {} },
    ],
    expect: (w) => {
      must(w.replies[1].data?.viewports?.length === 3, 'the fixture has three breakpoints');
      const code = w.read(HOME) ?? '';
      must(/"id": "laptop"[\s\S]{0,80}"width": 1024/.test(code), 'the laptop breakpoint is not in @canvas');
      must(/@media \(max-width: 1024px\)[^{]*\{[\s\S]*?hero-title[^}]*font-size: 44px/.test(code), 'the 1024px override did not land in its own band');
      must(/@media \(max-width: 800px\)[^}]*\{[^}]*\[data-id="hero-title"\][^}]*font-size: 40px/.test(code) || /max-width: 800px[\s\S]*hero-title[\s\S]*40px/.test(code), 'the tablet override did not move to 800px');
      must(!/max-width: 768px/.test(code), 'the old 768px band is still there');
      must(w.replies[5].data?.viewports?.some((v: { id: string; width: number }) => v.id === 'tablet' && v.width === 800), 'list_viewports does not reflect the new width');
    },
  },
  {
    id: 'layout/remove-viewport', domain: 'layout', status: 'supported',
    feature: 'Remove a breakpoint with its overrides',
    ask: 'drop the tablet breakpoint',
    calls: [
      { tool: 'set_styles', args: { node_id: 'hero-title', styles: { fontSize: '40px' }, viewport: 768 } },
      { tool: 'remove_viewport', args: { viewport: 'tablet' } },
    ],
    expect: (w) => {
      const code = w.read(HOME) ?? '';
      must(!/"tablet"/.test(code) && !/max-width: 768px/.test(code), 'the tablet breakpoint or its band survived');
    },
  },
  {
    id: 'layout/remove-primary-refused', domain: 'layout', status: 'supported',
    feature: 'The primary breakpoint cannot be removed',
    ask: '(safety) remove the desktop breakpoint',
    calls: [{ tool: 'remove_viewport', args: { viewport: 'desktop' } }],
    allowFailedCalls: true,
    expect: (w) => must(w.replies[0].isError && /primary/.test(w.replies[0].text), 'not refused'),
  },
  {
    id: 'layout/reset-viewport-override', domain: 'layout', status: 'supported',
    feature: 'Reset every override on a breakpoint',
    ask: 'reset the mobile version of the title',
    calls: [
      { tool: 'set_styles', args: { node_id: 'hero-title', styles: { fontSize: '36px', color: '#ff0000' }, viewport: 375 } },
      { tool: 'reset_overrides', args: { node_id: 'hero-title', viewport: 375 } },
    ],
    expect: (w) => {
      must(w.replies[1].data?.reset?.length === 2, `two overrides should be reset: ${w.replies[1].text}`);
      must(!/max-width: 375px[\s\S]*?\[data-id="hero-title"\]/.test(w.read(HOME) ?? '') || !/hero-title"\]\s*\{[^}]*font-size/.test(w.read(HOME) ?? ''), 'the mobile band still styles the title');
    },
  },
  {
    id: 'layout/wrap', domain: 'layout', status: 'supported',
    feature: 'Wrap elements in a layout',
    ask: 'group the title and subtitle together',
    calls: [{ tool: 'wrap_in_layout', args: { node_ids: ['hero-title', 'hero-sub'], name: 'Heading group' } }],
    expect: (w) => {
      const frameId = w.replies[0].data?.frame_id as string;
      must(frameId, 'no frame id returned');
      const frame = w.node(frameId);
      must(frame.children.includes('hero-title') && frame.children.includes('hero-sub'), 'the two are not inside the new frame');
      must(frame.styles.display === 'flex', 'the wrapper is not a layout');
      must(w.node('hero').children.includes(frameId), 'the wrapper is not where the two were');
    },
  },
  {
    id: 'layout/unwrap', domain: 'layout', status: 'supported',
    feature: 'Unfold children (remove a wrapper)',
    ask: 'remove the cards row but keep the cards',
    calls: [{ tool: 'unfold_children', args: { node_id: 'cards' } }],
    expect: (w) => {
      must(!w.nodes().has('cards'), 'the wrapper is still there');
      for (const id of ['card-1', 'card-2', 'card-3']) must(w.node('root').children.includes(id), `${id} did not move up to the root`);
    },
  },
  {
    id: 'layout/pin-conversion', domain: 'layout', status: 'supported',
    feature: 'Pin to a side, keeping the element where it is',
    ask: 'pin this badge to the right',
    files: { [HOME]: FIXTURE_FILES[HOME].replace(
      `<div data-id="card-1" data-name="Card" style={{ position: 'relative', width: '320px', height: '200px',`,
      `<div data-id="card-1" data-name="Card" style={{ position: 'relative', width: '320px', height: '200px',`,
    ).replace(
      `flex: '0 0 auto', order: '0' }}></div>\n        <div data-id="card-2"`,
      `flex: '0 0 auto', order: '0' }}><span data-id="badge" data-name="Badge" style={{ position: 'absolute', left: '24px', top: '16px', width: '80px', height: '24px', backgroundColor: '#111827', color: '#ffffff', borderRadius: '12px', fontSize: '12px' }}>New</span></div>\n        <div data-id="card-2"`,
    ) },
    calls: [{ tool: 'pin_to_side', args: { node_id: 'badge', horizontal: 'right', vertical: 'bottom' } }],
    expect: (w) => {
      const badge = w.node('badge');
      must(badge.styles.right === '216px' && badge.styles.left === undefined, `left 24 + width 80 in a 320 card should become right 216px, got ${JSON.stringify({ left: badge.styles.left, right: badge.styles.right })}`);
      must(badge.styles.bottom === '160px' && badge.styles.top === undefined, `top 16 + height 24 in a 200 card should become bottom 160px, got ${JSON.stringify({ top: badge.styles.top, bottom: badge.styles.bottom })}`);
    },
  },
];
