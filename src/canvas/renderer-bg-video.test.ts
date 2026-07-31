// @vitest-environment jsdom
// A frame with a video Fill must render its (frozen) <video> on the canvas from
// the FIRST paint — not only after a later patch cycle.
//
// `syncBgVideoChild` was called from `patchElement` alone. An element rendered
// from scratch (first paint, page switch, any subtree rebuild) therefore came out
// with no <video> child, and because an unchanged node model is patch-SKIPPED
// nothing ever inserted it: the video never appeared on the canvas no matter how
// many page switches, while the live site — which renders the <video> straight
// from the JSX — showed it fine. Live find 2026-07-25.
import { describe, it, expect, beforeEach } from 'vitest';
import { parseJSXToNodes } from '@/code/parsing/parser';
import { renderNodes } from '@/canvas/Renderer';

const SRC = 'https://assets.example.com/clip.mp4';

const PAGE = `
export default function Page() {
  return (
    <div data-id="root" style={{ position: 'relative', width: '100%' }}>
      <div data-id="hero" style={{ position: 'relative', width: '400px', height: '300px' }}>
        <video data-bg-video src="${SRC}" autoPlay muted loop playsInline style={{ objectFit: 'cover' }} />
      </div>
    </div>
  );
}`;

const PAGE_NO_VIDEO = `
export default function Page() {
  return (
    <div data-id="root" style={{ position: 'relative', width: '100%' }}>
      <div data-id="hero" style={{ position: 'relative', width: '400px', height: '300px' }}></div>
    </div>
  );
}`;

const viewports = [{ id: 'desktop', width: 1440, x: 0, y: 0, isPrimary: true }] as never;

function setup(): HTMLElement {
  (globalThis as { CSS?: { escape?: (s: string) => string } }).CSS ??= {};
  (globalThis as { CSS: { escape?: (s: string) => string } }).CSS.escape ??= (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
  document.body.innerHTML = '';
  const container = document.createElement('div');
  container.setAttribute('data-content-root', 'true');
  document.body.appendChild(container);
  return container;
}

const videoIn = (c: HTMLElement) => c.querySelector('[data-id="hero"] > video[data-bg-video]') as HTMLVideoElement | null;

describe('background video on the canvas', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('renders the <video> on the FIRST paint (the build path, not just patch)', () => {
    const container = setup();
    renderNodes(container, parseJSXToNodes(PAGE), null, () => {}, viewports, PAGE);
    const v = videoIn(container);
    expect(v).not.toBeNull();
    expect(v!.getAttribute('src')).toBe(SRC);
  });

  it('freezes it: autoplay + loop OFF, and preloaded so a frame actually paints', () => {
    const container = setup();
    renderNodes(container, parseJSXToNodes(PAGE), null, () => {}, viewports, PAGE);
    const v = videoIn(container)!;
    expect(v.autoplay).toBe(false); // JSX says autoPlay — the canvas overrides it
    expect(v.loop).toBe(false);     // …and loop
    expect(v.preload).toBe('auto'); // without this a frozen video can paint blank
  });

  it('is the FIRST child, behind the frame content', () => {
    const container = setup();
    renderNodes(container, parseJSXToNodes(PAGE), null, () => {}, viewports, PAGE);
    const hero = container.querySelector('[data-id="hero"]') as HTMLElement;
    expect(hero.firstElementChild).toBe(videoIn(container));
    expect(videoIn(container)!.style.zIndex).toBe('-1');
  });

  it('carries no data-id, so it is never selectable or hit-tested', () => {
    const container = setup();
    renderNodes(container, parseJSXToNodes(PAGE), null, () => {}, viewports, PAGE);
    expect(videoIn(container)!.hasAttribute('data-id')).toBe(false);
  });

  it('removes the <video> when the fill is cleared', () => {
    const container = setup();
    renderNodes(container, parseJSXToNodes(PAGE), null, () => {}, viewports, PAGE);
    expect(videoIn(container)).not.toBeNull();
    renderNodes(container, parseJSXToNodes(PAGE_NO_VIDEO), null, () => {}, viewports, PAGE_NO_VIDEO);
    expect(videoIn(container)).toBeNull();
  });
});
