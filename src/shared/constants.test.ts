// constants.test.ts — Tests for element type classification functions and tag sets.

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  canAcceptChildren,
  isLinkTag,
  nodeAcceptsChildren,
  isFrameTag,
  isTextTag,
  isSvgTag,
  FRAME_TAGS,
  TEXT_TAGS,
  MEDIA_TAGS,
  SVG_SHAPE_TAGS,
} from './constants';

// ─── canAcceptChildren ──────────────────────────────────────────────────────

describe('canAcceptChildren', () => {
  it('returns true for container tags', () => {
    expect(canAcceptChildren('div')).toBe(true);
    expect(canAcceptChildren('section')).toBe(true);
    expect(canAcceptChildren('article')).toBe(true);
    expect(canAcceptChildren('main')).toBe(true);
    expect(canAcceptChildren('header')).toBe(true);
    expect(canAcceptChildren('footer')).toBe(true);
    expect(canAcceptChildren('nav')).toBe(true);
    expect(canAcceptChildren('aside')).toBe(true);
    expect(canAcceptChildren('ul')).toBe(true);
    expect(canAcceptChildren('ol')).toBe(true);
    expect(canAcceptChildren('li')).toBe(true);
    expect(canAcceptChildren('form')).toBe(true);
  });

  it('returns false for text tags', () => {
    expect(canAcceptChildren('p')).toBe(false);
    expect(canAcceptChildren('h1')).toBe(false);
    expect(canAcceptChildren('span')).toBe(false);
    expect(canAcceptChildren('a')).toBe(false);
    expect(canAcceptChildren('strong')).toBe(false);
  });

  it('returns false for media tags', () => {
    expect(canAcceptChildren('img')).toBe(false);
    expect(canAcceptChildren('video')).toBe(false);
    expect(canAcceptChildren('svg')).toBe(false);
  });

  it('returns false for unknown tags', () => {
    expect(canAcceptChildren('custom-element')).toBe(false);
    expect(canAcceptChildren('')).toBe(false);
  });

  it('returns true for motion container tags', () => {
    expect(canAcceptChildren('motion.div')).toBe(true);
    expect(canAcceptChildren('motion.section')).toBe(true);
    expect(canAcceptChildren('motion.nav')).toBe(true);
  });

  it('returns false for motion text tags', () => {
    expect(canAcceptChildren('motion.p')).toBe(false);
    expect(canAcceptChildren('motion.span')).toBe(false);
  });
});

// ─── isFrameTag ─────────────────────────────────────────────────────────────

describe('isFrameTag', () => {
  it('returns true for frame/container tags', () => {
    expect(isFrameTag('div')).toBe(true);
    expect(isFrameTag('section')).toBe(true);
    expect(isFrameTag('nav')).toBe(true);
    expect(isFrameTag('article')).toBe(true);
    expect(isFrameTag('aside')).toBe(true);
    expect(isFrameTag('main')).toBe(true);
    expect(isFrameTag('header')).toBe(true);
    expect(isFrameTag('footer')).toBe(true);
    expect(isFrameTag('figure')).toBe(true);
    expect(isFrameTag('fieldset')).toBe(true);
    expect(isFrameTag('form')).toBe(true);
    expect(isFrameTag('ul')).toBe(true);
    expect(isFrameTag('ol')).toBe(true);
    expect(isFrameTag('li')).toBe(true);
    expect(isFrameTag('table')).toBe(true);
    expect(isFrameTag('tr')).toBe(true);
    expect(isFrameTag('td')).toBe(true);
    expect(isFrameTag('dialog')).toBe(true);
    expect(isFrameTag('blockquote')).toBe(true);
  });

  it('returns false for text tags', () => {
    expect(isFrameTag('p')).toBe(false);
    expect(isFrameTag('h1')).toBe(false);
    expect(isFrameTag('span')).toBe(false);
    expect(isFrameTag('a')).toBe(false);
  });

  it('returns false for media tags', () => {
    expect(isFrameTag('img')).toBe(false);
    expect(isFrameTag('svg')).toBe(false);
  });

  it('returns true for motion frame tags', () => {
    expect(isFrameTag('motion.div')).toBe(true);
    expect(isFrameTag('motion.section')).toBe(true);
    expect(isFrameTag('motion.article')).toBe(true);
    expect(isFrameTag('motion.header')).toBe(true);
    expect(isFrameTag('motion.footer')).toBe(true);
    expect(isFrameTag('motion.nav')).toBe(true);
    expect(isFrameTag('motion.main')).toBe(true);
    expect(isFrameTag('motion.aside')).toBe(true);
    expect(isFrameTag('motion.ul')).toBe(true);
    expect(isFrameTag('motion.ol')).toBe(true);
    expect(isFrameTag('motion.li')).toBe(true);
  });
});

// ─── isTextTag ──────────────────────────────────────────────────────────────

describe('isTextTag', () => {
  it('returns true for text tags', () => {
    expect(isTextTag('p')).toBe(true);
    expect(isTextTag('span')).toBe(true);
    expect(isTextTag('h1')).toBe(true);
    expect(isTextTag('h2')).toBe(true);
    expect(isTextTag('h3')).toBe(true);
    expect(isTextTag('h4')).toBe(true);
    expect(isTextTag('h5')).toBe(true);
    expect(isTextTag('h6')).toBe(true);
    expect(isTextTag('a')).toBe(true);
    expect(isTextTag('strong')).toBe(true);
    expect(isTextTag('em')).toBe(true);
    expect(isTextTag('label')).toBe(true);
    expect(isTextTag('code')).toBe(true);
    expect(isTextTag('pre')).toBe(true);
  });

  it('returns false for frame tags', () => {
    expect(isTextTag('div')).toBe(false);
    expect(isTextTag('section')).toBe(false);
    expect(isTextTag('nav')).toBe(false);
  });

  it('returns false for media tags', () => {
    expect(isTextTag('img')).toBe(false);
    expect(isTextTag('svg')).toBe(false);
  });

  it('returns true for motion text tags', () => {
    expect(isTextTag('motion.p')).toBe(true);
    expect(isTextTag('motion.span')).toBe(true);
    expect(isTextTag('motion.h1')).toBe(true);
    expect(isTextTag('motion.h2')).toBe(true);
    expect(isTextTag('motion.h3')).toBe(true);
    expect(isTextTag('motion.a')).toBe(true);
  });
});

// ─── isSvgTag ───────────────────────────────────────────────────────────────

describe('isSvgTag', () => {
  it('returns true for "svg" wrapper', () => {
    expect(isSvgTag('svg')).toBe(true);
  });

  it('returns true for SVG shape tags', () => {
    expect(isSvgTag('rect')).toBe(true);
    expect(isSvgTag('circle')).toBe(true);
    expect(isSvgTag('ellipse')).toBe(true);
    expect(isSvgTag('polygon')).toBe(true);
    expect(isSvgTag('path')).toBe(true);
    expect(isSvgTag('line')).toBe(true);
    expect(isSvgTag('polyline')).toBe(true);
    expect(isSvgTag('g')).toBe(true);
  });

  it('returns false for non-SVG tags', () => {
    expect(isSvgTag('div')).toBe(false);
    expect(isSvgTag('p')).toBe(false);
    expect(isSvgTag('img')).toBe(false);
    expect(isSvgTag('span')).toBe(false);
  });

  it('returns false for unknown tags', () => {
    expect(isSvgTag('custom')).toBe(false);
    expect(isSvgTag('')).toBe(false);
  });
});

// ─── Tag Set Snapshots ──────────────────────────────────────────────────────

describe('FRAME_TAGS', () => {
  it('contains all expected base HTML container tags', () => {
    const expected = [
      'div', 'section', 'article', 'aside', 'main', 'header', 'footer', 'nav',
      'figure', 'figcaption', 'details', 'summary', 'fieldset', 'form',
      'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'table', 'thead', 'tbody', 'tr', 'td', 'th',
      'dialog', 'menu', 'address', 'blockquote',
    ];
    for (const tag of expected) {
      expect(FRAME_TAGS.has(tag)).toBe(true);
    }
  });

  it('contains motion variants of frame tags', () => {
    expect(FRAME_TAGS.has('motion.div')).toBe(true);
    expect(FRAME_TAGS.has('motion.section')).toBe(true);
    expect(FRAME_TAGS.has('motion.nav')).toBe(true);
  });

  it('does not contain text or media tags', () => {
    expect(FRAME_TAGS.has('p')).toBe(false);
    expect(FRAME_TAGS.has('span')).toBe(false);
    expect(FRAME_TAGS.has('img')).toBe(false);
  });
});

describe('TEXT_TAGS', () => {
  it('contains all expected text tags', () => {
    const expected = [
      'p', 'span', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'a', 'strong', 'em', 'b', 'i', 'u', 's', 'small', 'sub', 'sup',
      'label', 'legend', 'caption', 'abbr', 'cite', 'code', 'pre', 'kbd', 'var',
      'time', 'mark', 'del', 'ins', 'q', 'dfn', 'samp',
    ];
    for (const tag of expected) {
      expect(TEXT_TAGS.has(tag)).toBe(true);
    }
  });

  it('contains motion variants of text tags', () => {
    expect(TEXT_TAGS.has('motion.p')).toBe(true);
    expect(TEXT_TAGS.has('motion.span')).toBe(true);
    expect(TEXT_TAGS.has('motion.h1')).toBe(true);
    expect(TEXT_TAGS.has('motion.a')).toBe(true);
  });

  it('does not contain frame tags', () => {
    expect(TEXT_TAGS.has('div')).toBe(false);
    expect(TEXT_TAGS.has('section')).toBe(false);
  });
});

describe('MEDIA_TAGS', () => {
  it('contains expected media tags', () => {
    const expected = [
      'img', 'video', 'audio', 'canvas', 'svg', 'iframe', 'embed', 'object',
      'picture', 'source', 'track',
    ];
    for (const tag of expected) {
      expect(MEDIA_TAGS.has(tag)).toBe(true);
    }
  });

  it('contains motion.img', () => {
    expect(MEDIA_TAGS.has('motion.img')).toBe(true);
  });
});

describe('SVG_SHAPE_TAGS', () => {
  it('contains all expected SVG shape tags', () => {
    const expected = ['rect', 'circle', 'ellipse', 'polygon', 'path', 'line', 'polyline', 'g'];
    for (const tag of expected) {
      expect(SVG_SHAPE_TAGS.has(tag)).toBe(true);
    }
  });

  it('does not contain "svg" (that is the wrapper, not a shape)', () => {
    expect(SVG_SHAPE_TAGS.has('svg')).toBe(false);
  });

  it('does not contain HTML tags', () => {
    expect(SVG_SHAPE_TAGS.has('div')).toBe(false);
    expect(SVG_SHAPE_TAGS.has('p')).toBe(false);
  });
});

describe('refreshAccentColors — master re-skin must not bake into the accent mirrors', () => {
  // Regression: while a component master is open, App.tsx inline-overrides
  // `--accent` to `var(--accent-secondary)` on <html>. getComputedStyle
  // resolves that override, so a refresh during the master session baked
  // PURPLE into SELECTION_COLOR — and it stayed purple after exiting to a
  // normal page (the exit removes an inline STYLE the old class-only
  // observer never saw). Deterministic repro was reloading while
  // deep-linked into a master: the module's one-frame rAF re-resolve
  // landed after the re-skin effect.
  const rootStyle = () => document.documentElement.style;

  afterEach(async () => {
    rootStyle().removeProperty('--accent');
    vi.restoreAllMocks();
    // Re-sync the module globals back to whatever the (jsdom) theme reports
    // so later suites aren't affected by our fake computed styles.
    const mod = await import('./constants');
    mod.refreshAccentColors();
  });

  const fakeComputed = (accent: string, secondary: string, selection = '#3b82f6') => {
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      getPropertyValue: (prop: string) =>
        prop === '--accent' ? accent
          : prop === '--accent-secondary' ? secondary
            : prop === '--selection' ? selection : '',
    } as unknown as CSSStyleDeclaration);
  };

  it('skips the accent mirrors while the inline --accent override is active', async () => {
    const mod = await import('./constants');
    // Baseline: amber chrome accent, blue canvas selection, no override.
    fakeComputed('#e8622c', '#9a66ff');
    mod.refreshAccentColors();
    expect(mod.SELECTION_COLOR).toBe('#3b82f6');
    expect(mod.COMPONENT_COLOR).toBe('#9a66ff');

    // Master re-skin active: inline override present, computed --accent
    // resolves to the SECONDARY purple. The mirrors must NOT follow it.
    rootStyle().setProperty('--accent', 'var(--accent-secondary)');
    fakeComputed('#9a66ff', '#9a66ff');
    mod.refreshAccentColors();
    expect(mod.SELECTION_COLOR).toBe('#3b82f6'); // still the canvas blue
    expect(mod.COMPONENT_COLOR).toBe('#9a66ff');
  });

  it('re-syncs to the theme accent once the override is lifted (exit master)', async () => {
    const mod = await import('./constants');
    // Simulate a PREVIOUSLY-stuck session: override active and (via the old
    // bug) purple already baked in — the guard skips while overridden.
    rootStyle().setProperty('--accent', 'var(--accent-secondary)');
    fakeComputed('#9a66ff', '#9a66ff');
    mod.refreshAccentColors();

    // Exit the master: override removed, computed --accent back to amber.
    // The style-attribute observer fires refreshAccentColors — mirrors
    // must return to the theme values.
    rootStyle().removeProperty('--accent');
    fakeComputed('#e8622c', '#9a66ff');
    mod.refreshAccentColors();
    expect(mod.SELECTION_COLOR).toBe('#3b82f6');
    expect(mod.COMPONENT_COLOR).toBe('#9a66ff');
  });

  // The amber rebrand split these apart: chrome is warm, the canvas stays blue.
  // Wiring selection back to --accent would tint every selection box, resize
  // handle and drop indicator amber — unreadable over warm artwork, and it
  // reads as a warning state.
  it('tracks --selection for canvas overlays, NOT the brand --accent', async () => {
    const mod = await import('./constants');
    fakeComputed('#e8622c', '#7c5cff', '#2563eb');
    mod.refreshAccentColors();
    expect(mod.SELECTION_COLOR).toBe('#2563eb');
    expect(mod.SELECTION_COLOR).not.toBe('#e8622c');
  });

  it('follows --selection when the theme flips it (light vs dark blue)', async () => {
    const mod = await import('./constants');
    fakeComputed('#c94a18', '#6d45ff', '#2563eb');
    mod.refreshAccentColors();
    expect(mod.SELECTION_COLOR).toBe('#2563eb');

    fakeComputed('#e8622c', '#7c5cff', '#3b82f6');
    mod.refreshAccentColors();
    expect(mod.SELECTION_COLOR).toBe('#3b82f6');
  });

  it('keeps the component violet distinct from both accent and selection', async () => {
    const mod = await import('./constants');
    fakeComputed('#e8622c', '#7c5cff', '#3b82f6');
    mod.refreshAccentColors();
    expect(mod.COMPONENT_COLOR).toBe('#7c5cff');
    expect(mod.COMPONENT_COLOR).not.toBe(mod.SELECTION_COLOR);
  });
});

// ─── nodeAcceptsChildren (the link exception) ───────────────────────────────
//
// A link is dual-natured: `<a>click here</a>` is text, `<Link><div/><h3/></Link>`
// is a flex container. The CMS row-navigation feature turns EVERY collection-list
// row into `<Link data-cms-nav="row">` wrapping the card's image + headings — and
// the tag-only test said "not a frame", so the drag system skipped the row and you
// could only drop BESIDE the card in the list, never inside it (user report
// 2026-07-26). `MotionLink` had already been special-cased into FRAME_TAGS for the
// same reason; this rule covers all three link tags without making a bare text
// link droppable.

describe('isLinkTag', () => {
  it('covers all three link tags', () => {
    expect(isLinkTag('a')).toBe(true);
    expect(isLinkTag('Link')).toBe(true);
    expect(isLinkTag('MotionLink')).toBe(true);
  });
  it('is false for everything else', () => {
    expect(isLinkTag('div')).toBe(false);
    expect(isLinkTag('p')).toBe(false);
  });
});

describe('nodeAcceptsChildren', () => {
  it('accepts a CMS row link that WRAPS element children', () => {
    expect(nodeAcceptsChildren({ type: 'Link', children: ['img-1', 'h3-1'] })).toBe(true);
  });

  it('accepts the same shape for `a` and MotionLink', () => {
    expect(nodeAcceptsChildren({ type: 'a', children: ['div-1'] })).toBe(true);
    expect(nodeAcceptsChildren({ type: 'MotionLink', children: ['div-1'] })).toBe(true);
  });

  it('REJECTS a bare text link (no element children)', () => {
    expect(nodeAcceptsChildren({ type: 'a', children: [] })).toBe(false);
    expect(nodeAcceptsChildren({ type: 'Link', children: [] })).toBe(false);
    expect(nodeAcceptsChildren({ type: 'Link' })).toBe(false);
  });

  it('still accepts ordinary frames, empty or not', () => {
    expect(nodeAcceptsChildren({ type: 'div', children: [] })).toBe(true);
    expect(nodeAcceptsChildren({ type: 'section' })).toBe(true);
  });

  it('still rejects text tags however many children they list', () => {
    expect(nodeAcceptsChildren({ type: 'p', children: ['span-1'] })).toBe(false);
    expect(nodeAcceptsChildren({ type: 'h3', children: ['span-1'] })).toBe(false);
  });

  it('defaults a typeless node to div (the node-map default)', () => {
    expect(nodeAcceptsChildren({ children: [] })).toBe(true);
  });

  it('is false for a missing node', () => {
    expect(nodeAcceptsChildren(null)).toBe(false);
    expect(nodeAcceptsChildren(undefined)).toBe(false);
  });
});
