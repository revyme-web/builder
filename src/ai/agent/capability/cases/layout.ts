// Layout, sizing, positioning & responsive — audit §7.
import type { CapabilityCase } from '../harness';

const px = (v: unknown) => String(v ?? '');

export const LAYOUT_CASES: CapabilityCase[] = [
  {
    id: 'layout/set-styles', domain: 'layout', status: 'supported',
    feature: 'Set arbitrary CSS on a node',
    ask: 'make the hero background light grey',
    calls: [{ tool: 'set_styles', args: { node_id: 'hero', styles: { backgroundColor: '#f4f4f5' } } }],
    expect: (w) => { if (w.node('hero').styles.backgroundColor !== '#f4f4f5') throw new Error(`backgroundColor = ${w.node('hero').styles.backgroundColor}`); },
  },
  {
    id: 'layout/remove-style', domain: 'layout', status: 'supported',
    feature: 'Remove a style with ""',
    ask: 'remove the rounded corners from the hero image',
    calls: [{ tool: 'set_styles', args: { node_id: 'hero-image', styles: { borderRadius: '' } } }],
    expect: (w) => { if ('borderRadius' in w.node('hero-image').styles) throw new Error('borderRadius is still there'); },
  },
  {
    id: 'layout/flex-direction', domain: 'layout', status: 'supported',
    feature: 'Flex layout: direction, alignment, gap',
    ask: 'stack the cards vertically with 16px between them',
    calls: [{ tool: 'set_layout', args: { node_id: 'cards', flexDirection: 'column', alignItems: 'center', gap: '16px' } }],
    expect: (w) => {
      const s = w.node('cards').styles;
      if (s.flexDirection !== 'column' || s.gap !== '16px' || s.alignItems !== 'center') throw new Error(JSON.stringify(s));
    },
  },
  {
    id: 'layout/size-px', domain: 'layout', status: 'supported',
    feature: 'Fixed size in px',
    ask: 'make the first card 400 by 260',
    calls: [{ tool: 'set_size', args: { node_id: 'card-1', width: '400px', height: '260px' } }],
    expect: (w) => { const s = w.node('card-1').styles; if (px(s.width) !== '400px' || px(s.height) !== '260px') throw new Error(JSON.stringify(s)); },
  },
  {
    id: 'layout/min-max', domain: 'layout', status: 'supported',
    feature: 'Min / max size',
    ask: 'cap the hero image at 1200px wide',
    calls: [{ tool: 'set_size', args: { node_id: 'hero-image', maxWidth: '1200px' } }],
    expect: (w) => { if (px(w.node('hero-image').styles.maxWidth) !== '1200px') throw new Error('maxWidth not set'); },
  },
  {
    id: 'layout/position-absolute', domain: 'layout', status: 'supported',
    feature: 'Absolute position with pins',
    ask: 'pin the third card to the top-right corner of the cards row',
    calls: [{ tool: 'set_position', args: { node_id: 'card-3', mode: 'absolute', top: '24px', right: '24px' } }],
    expect: (w) => { const s = w.node('card-3').styles; if (s.position !== 'absolute' || s.top !== '24px' || s.right !== '24px') throw new Error(JSON.stringify(s)); },
  },
  {
    id: 'layout/responsive-override', domain: 'layout', status: 'supported',
    feature: 'Per-breakpoint style override',
    ask: 'on mobile make the title 36px',
    calls: [{ tool: 'set_styles', args: { node_id: 'hero-title', styles: { fontSize: '36px' }, viewport: 375 } }],
    expect: (w) => {
      const code = w.read('app/page.client.tsx') ?? '';
      if (w.node('hero-title').styles.fontSize !== '64px') throw new Error('the desktop value changed');
      if (!/@media[^{]*max-width:\s*375/.test(code) || !/hero-title[\s\S]{0,200}36px/.test(code)) throw new Error('no mobile @media rule for the title');
    },
  },
  {
    id: 'layout/responsive-layout', domain: 'layout', status: 'supported',
    feature: 'Per-breakpoint layout (stack on mobile)',
    ask: 'on mobile stack the cards vertically',
    calls: [{ tool: 'set_styles', args: { node_id: 'cards', styles: { flexDirection: 'column' }, viewport: 375 } }],
    expect: (w) => {
      const code = w.read('app/page.client.tsx') ?? '';
      if (w.node('cards').styles.flexDirection !== 'row') throw new Error('the desktop direction changed');
      if (!/max-width:\s*375[\s\S]*cards[\s\S]{0,200}column/.test(code)) throw new Error('no mobile rule stacking the cards');
    },
  },
];
