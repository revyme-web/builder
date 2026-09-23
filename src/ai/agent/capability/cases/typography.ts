// Typography, presets, tokens, variables & paint — audit §6.
import type { CapabilityCase } from '../harness';
import { HOME, TOKENS } from '../fixture';

const must = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };

export const TYPOGRAPHY_CASES: CapabilityCase[] = [
  {
    id: 'typography/set-typography', domain: 'typography', status: 'supported',
    feature: 'Set typography on a node',
    ask: 'make the title 72px, bold, tight line height, centred',
    calls: [{ tool: 'set_typography', args: { node_id: 'hero-title', fontSize: '72px', fontWeight: 800, lineHeight: '1.05', textAlign: 'center' } }],
    expect: (w) => {
      const s = w.node('hero-title').styles;
      must(s.fontSize === '72px' && String(s.fontWeight) === '800' && s.lineHeight === '1.05' && s.textAlign === 'center', JSON.stringify(s));
    },
  },
  {
    // The tool used to document "a px string OR a unitless ratio" while the
    // oracle bans px — so a px value is REFUSED at the tool, with the rule.
    id: 'typography/line-height-px-refused', domain: 'typography', status: 'supported',
    feature: 'A px line height is refused with the rule, not bounced later',
    ask: 'set the subtitle line height to 28px',
    calls: [{ tool: 'set_typography', args: { node_id: 'hero-sub', lineHeight: '28px' } }],
    allowFailedCalls: true,
    expect: (w) => {
      must(w.replies[0].isError && /unitless/.test(w.replies[0].text), 'the px value was not refused with the rule');
      must(w.node('hero-sub').styles.lineHeight === '1.5', 'the file changed');
    },
  },
  {
    id: 'typography/responsive-type', domain: 'typography', status: 'supported',
    feature: 'Per-breakpoint font size',
    ask: 'on tablet make the title 48px',
    calls: [{ tool: 'set_styles', args: { node_id: 'hero-title', styles: { fontSize: '48px' }, viewport: 768 } }],
    expect: (w) => {
      must(w.node('hero-title').styles.fontSize === '64px', 'the desktop size changed');
      must(/max-width:\s*768[\s\S]*hero-title[\s\S]{0,200}48px/.test(w.read(HOME) ?? ''), 'no tablet rule');
    },
  },
  {
    id: 'typography/update-token', domain: 'typography', status: 'supported',
    feature: 'Update a design token',
    ask: 'change the brand colour to orange',
    calls: [{ tool: 'set_token', args: { name: 'color-brand', value: '#f97316' } }],
    expect: (w) => must(/--color-brand:\s*#f97316/.test(w.read(TOKENS) ?? ''), 'the token value did not change'),
  },
  {
    id: 'typography/read-tokens', domain: 'typography', status: 'supported',
    feature: 'Read the design tokens',
    ask: 'what colours does this site use?',
    calls: [{ tool: 'get_design_tokens', args: {} }],
    expect: (w) => must(/color-brand/.test(w.replies[0].text) && /#6366f1/.test(w.replies[0].text), 'the reply lacks the brand token'),
  },
  {
    id: 'typography/use-token', domain: 'typography', status: 'supported',
    feature: 'Use a token as a style value',
    ask: 'make the first card the brand colour',
    calls: [{ tool: 'set_styles', args: { node_id: 'card-1', styles: { backgroundColor: 'var(--color-brand)' } } }],
    expect: (w) => must(w.node('card-1').styles.backgroundColor === 'var(--color-brand)', 'the token reference was not written'),
  },
  {
    id: 'typography/plain-text', domain: 'typography', status: 'supported',
    feature: 'Set text content',
    ask: 'change the headline to "Ship with confidence"',
    calls: [{ tool: 'set_text', args: { node_id: 'hero-title', text: 'Ship with confidence' } }],
    expect: (w) => must(/Ship with confidence/.test(w.read(HOME) ?? ''), 'the text did not change'),
  },
  {
    id: 'typography/rich-text', domain: 'typography', status: 'supported',
    feature: 'Rich text (marks)',
    ask: 'make the word "release" in the headline orange',
    calls: [{ tool: 'set_rich_text', args: { node_id: 'hero-title', html: 'Plan, build and <span style="color: #f97316">release</span>' } }],
    expect: (w) => must(/release/.test(w.read(HOME) ?? '') && /#f97316/.test(w.read(HOME) ?? ''), 'the coloured run is not in the file'),
  },
  {
    id: 'typography/gradient-fill', domain: 'typography', status: 'supported',
    feature: 'Gradient fill',
    ask: 'give the hero a soft orange-to-white gradient',
    calls: [{ tool: 'set_styles', args: { node_id: 'hero', styles: { backgroundImage: 'linear-gradient(180deg, #fed7aa 0%, #ffffff 100%)' } } }],
    expect: (w) => must(/linear-gradient/.test(String(w.node('hero').styles.backgroundImage)), 'no gradient on the hero'),
  },
  {
    id: 'typography/shadow-blur', domain: 'typography', status: 'supported',
    feature: 'Shadow, backdrop blur, blend',
    ask: 'give the cards a soft shadow',
    calls: [{ tool: 'set_styles', args: { node_id: 'card-1', styles: { boxShadow: '0px 8px 24px rgba(15, 23, 42, 0.12)' } } }],
    expect: (w) => must(/rgba\(15, 23, 42, 0\.12\)/.test(String(w.node('card-1').styles.boxShadow)), 'no shadow'),
  },
  {
    id: 'typography/page-variable', domain: 'typography', status: 'supported',
    feature: 'Declare a page variable',
    ask: 'add a "menuOpen" toggle to this page',
    calls: [{ tool: 'set_page_variable', args: { name: 'menuOpen', type: 'boolean', value: 'false' } }],
    // A variable is DECLARED in the page's @pageVariables block; its useState
    // hook lands when an interaction first uses it (see i18n-vars-forms cases).
    expect: (w) => must(/@pageVariables[\s\S]*"name": "menuOpen"[\s\S]*"type": "boolean"/.test(w.read(HOME) ?? ''), 'menuOpen is not declared in @pageVariables'),
  },

  // ── not possible yet ──
  {
    id: 'typography/font-family', domain: 'typography', status: 'supported',
    feature: 'Pick a web font that actually loads',
    ask: 'use Playfair Display for the headline',
    calls: [{ tool: 'set_font', args: { node_id: 'hero-title', family: 'Playfair Display', fallback: 'serif' } }],
    expect: (w) => {
      must(/Playfair Display/.test(String(w.node('hero-title').styles.fontFamily)), 'fontFamily not written');
      must(/@import url\('https:\/\/fonts\.googleapis\.com\/css2\?family=Playfair\+Display/.test(w.read(TOKENS) ?? ''), 'the font is not loaded (no @import in globals.css)');
    },
  },
  {
    id: 'typography/create-token', domain: 'typography', status: 'supported',
    feature: 'Create a design token and use it',
    ask: 'add an accent colour and use it on the first card',
    calls: [
      { tool: 'create_token', args: { name: 'color-accent', value: '#f97316' } },
      { tool: 'set_styles', args: { node_id: 'card-1', styles: { backgroundColor: 'var(--color-accent)' } } },
    ],
    expect: (w) => {
      must(/--color-accent:\s*#f97316/.test(w.read(TOKENS) ?? ''), 'the token is not in globals.css');
      must(w.node('card-1').styles.backgroundColor === 'var(--color-accent)', 'the card does not use it');
    },
  },
  {
    id: 'typography/create-token-bad-name', domain: 'typography', status: 'supported',
    feature: 'A badly named token is refused with the rule',
    ask: 'add a token called "Accent Colour"',
    calls: [{ tool: 'create_token', args: { name: 'Accent Colour', value: '#f97316' } }],
    allowFailedCalls: true,
    expect: (w) => must(w.replies[0].isError && /kebab-case/.test(w.replies[0].text), 'not refused with the naming rule'),
  },
  {
    id: 'typography/remove-token', domain: 'typography', status: 'supported',
    feature: 'Remove an unused design token',
    ask: 'delete the section spacing token',
    calls: [{ tool: 'remove_token', args: { name: 'space-section' } }],
    expect: (w) => must(!/--space-section/.test(w.read(TOKENS) ?? ''), 'the token is still there'),
  },
  {
    id: 'typography/remove-token-in-use', domain: 'typography', status: 'supported',
    feature: 'A token in use cannot be removed',
    ask: 'delete the ink colour',
    calls: [{ tool: 'remove_token', args: { name: 'color-ink' } }],
    allowFailedCalls: true,
    expect: (w) => {
      must(w.replies[0].isError && /still used/.test(w.replies[0].text), 'an in-use token was removed (dead var() references)');
      must(/--color-ink/.test(w.read(TOKENS) ?? ''), 'the token was removed anyway');
    },
  },
  {
    id: 'typography/dark-token', domain: 'typography', status: 'supported',
    feature: 'Dark-theme token value',
    ask: 'make the surface dark in dark mode',
    calls: [{ tool: 'set_dark_token', args: { name: 'color-surface', dark_value: '#0b0b0f' } }],
    expect: (w) => {
      const css = w.read(TOKENS) ?? '';
      must(/:root\.dark\s*\{[^}]*--color-surface:\s*#0b0b0f/.test(css), 'no :root.dark value');
      must(/--color-surface:\s*#ffffff/.test(css), 'the light value changed');
    },
  },
  {
    id: 'typography/typography-preset', domain: 'typography', status: 'supported',
    feature: 'Create a typography preset',
    ask: 'create a Heading text style: 56px, bold, tight',
    calls: [{ tool: 'set_typography_preset', args: { name: 'heading', tag: 'h2', values: { size: '56px', weight: '700', 'line-height': '1.1', 'size-md': '40px' } } }],
    expect: (w) => {
      const css = w.read(TOKENS) ?? '';
      for (const t of ['--typo-heading-size: 56px', '--typo-heading-weight: 700', '--typo-heading-line-height: 1.1', '--typo-heading-size-md: 40px', '--typo-heading-tag: h2']) {
        must(css.includes(t), `missing ${t}`);
      }
    },
  },
  {
    id: 'typography/apply-preset', domain: 'typography', status: 'supported',
    feature: 'Apply a typography preset to a node',
    ask: 'make the subtitle use the Heading style',
    calls: [
      { tool: 'set_typography_preset', args: { name: 'heading', tag: 'h2', values: { size: '56px', 'size-md': '40px' } } },
      { tool: 'apply_typography_preset', args: { node_id: 'hero-sub', preset: 'heading' } },
    ],
    expect: (w) => {
      const n = w.node('hero-sub');
      must(n.styles.fontSize === 'var(--typo-heading-size)', `fontSize is ${n.styles.fontSize}`);
      must(n.type === 'h2', `the element was not retagged to h2 (is ${n.type})`);
      must(/hero-sub[\s\S]{0,300}var\(--typo-heading-size-md\)/.test(w.read(HOME) ?? ''), 'the responsive tier is not written');
    },
  },
  {
    id: 'typography/bind-variable', domain: 'typography', status: 'supported',
    feature: 'Bind a variable to a style or text',
    ask: 'show the counter value in the subtitle and tint the title with the accent variable',
    calls: [
      { tool: 'set_page_variable', args: { name: 'count', type: 'number', value: '3' } },
      { tool: 'set_page_variable', args: { name: 'accent', type: 'color', value: '#2563eb' } },
      { tool: 'bind_variable', args: { node_id: 'hero-sub', variable: 'count', bind: 'text' } },
      { tool: 'bind_variable', args: { node_id: 'hero-title', variable: 'accent', bind: 'color' } },
    ],
    expect: (w) => {
      const code = w.read(HOME) ?? '';
      must(/data-id="hero-sub"[^>]*>\{count\}</.test(code), 'the subtitle does not render {count}');
      must(/color: accent/.test(w.tag('hero-title')), 'the title colour is not bound to accent');
      must(/useState\(3\)|useState\("3"\)|useState\('3'\)/.test(code) && /useState\(['"]#2563eb['"]\)/.test(code), 'the variables have no state hooks');
    },
  },
  {
    id: 'typography/per-band-text', domain: 'typography', status: 'supported',
    feature: 'Different text per breakpoint',
    ask: 'use a shorter headline on mobile',
    calls: [{ tool: 'set_text_on_breakpoint', args: { node_id: 'hero-title', viewport: 375, text: 'Plan & ship' } }],
    expect: (w) => {
      const code = w.read(HOME) ?? '';
      must(/useResponsiveText/.test(code), 'no responsive text hook');
      must(/Plan & ship|Plan &amp; ship/.test(code), 'the mobile text is not in the page');
      must(/Plan, build and release/.test(code), 'the base text was lost');
    },
  },
  {
    id: 'typography/fit-text', domain: 'typography', status: 'supported',
    feature: 'Fit text',
    ask: 'make the headline fit the full width, then back to a normal size',
    calls: [
      { tool: 'set_text_fit', args: { node_id: 'hero-title', fit: true } },
      { tool: 'set_text_fit', args: { node_id: 'hero-title', fit: false } },
    ],
    expect: (w) => {
      must(w.replies[0].data?.wrapper === 'hero-title-svg', `no Fit wrapper reported: ${w.replies[0].text.slice(0, 200)}`);
      must(w.replies[1].data?.fit === false && /px$/.test(w.replies[1].data?.font_size ?? ''), `unfit did not restore a px size: ${w.replies[1].text.slice(0, 200)}`);
      const title = w.node('hero-title');
      must(!w.nodes().has('hero-title-svg') && title.parentId === 'hero', 'the wrapper is still there after unfit');
    },
  },
  {
    id: 'typography/fit-text-shape', domain: 'typography', status: 'supported',
    feature: 'A Fit text is the svg + foreignObject shape the Text panel edits',
    ask: 'make the headline fit the full width',
    calls: [{ tool: 'set_text_fit', args: { node_id: 'hero-title', fit: true } }],
    expect: (w) => {
      const code = w.read(HOME) ?? '';
      must(/<svg[^>]*data-id="hero-title-svg"[^>]*viewBox="0 0 \d+ \d+"/.test(code), 'no Fit svg wrapper with a viewBox');
      must(/<foreignObject[\s\S]*?data-id="hero-title"/.test(code), 'the text is not inside the foreignObject');
      const wrapper = w.node('hero-title-svg');
      must(wrapper.parentId === 'hero' && /px$|%$/.test(wrapper.styles.width ?? ''), `the wrapper took the text's layout slot with a fixed / relative width: ${wrapper.styles.width}`);
    },
  },
];
