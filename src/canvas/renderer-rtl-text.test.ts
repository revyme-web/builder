// @vitest-environment jsdom
// Switching the canvas to Arabic put `dir="rtl"` on the content root: every
// flex row, grid and default alignment mirrored while absolute nodes kept
// their `left` (user report 2026-10-16). The canvas now only tags `lang` and
// ships the text-only rule; it never mirrors the layout.
import { describe, it, expect } from 'vitest';

import { parseJSXToNodes } from '@/code/parsing/parser';
import { renderNodes } from '@/canvas/Renderer';
import { RTL_TEXT_CSS } from '@/shared/rtl-text';

const PAGE = `
export default function Page() {
  return (
    <div data-id="root" style={{ position: 'relative', width: '100%' }}>
      <div data-id="nav" style={{ display: 'flex', flexDirection: 'row' }}>
        <p data-id="logo">bachuki</p>
      </div>
    </div>
  );
}`;
const viewports = [{ id: 'desktop', width: 1440, x: 0, y: 0, isPrimary: true }] as any;

function setup() {
  (globalThis as any).CSS = (globalThis as any).CSS ?? {};
  (globalThis as any).CSS.escape = (globalThis as any).CSS.escape ?? ((s: string) => s.replace(/[^a-zA-Z0-9_-]/g, (c: string) => `\\${c}`));
  document.body.innerHTML = '';
  const container = document.createElement('div');
  container.setAttribute('data-content-root', 'true');
  document.body.appendChild(container);
  return container;
}

const render = (container: HTMLElement, active?: string, def = 'en') =>
  renderNodes(container, parseJSXToNodes(PAGE), null, () => {}, viewports, PAGE, active, def);

describe('RTL locale on the canvas', () => {
  it('Arabic tags lang and the text rule — no dir, so rows stay as built', () => {
    const container = setup();
    container.setAttribute('dir', 'rtl');   // left behind by the old renderer
    render(container, 'ar');
    expect(container.getAttribute('lang')).toBe('ar');
    expect(container.hasAttribute('dir')).toBe(false);
    const style = container.querySelectorAll(':scope > [data-canvas-rtl-text]');
    expect(style).toHaveLength(1);
    expect(style[0].textContent).toBe(RTL_TEXT_CSS);
  });

  it('re-renders keep ONE rule element; back to the default locale drops lang', () => {
    const container = setup();
    render(container, 'ar');
    render(container, 'ar');
    render(container, 'en');
    expect(container.querySelectorAll('[data-canvas-rtl-text]')).toHaveLength(1);
    expect(container.hasAttribute('lang')).toBe(false);
    expect(container.hasAttribute('dir')).toBe(false);
  });

  it('an RTL DEFAULT locale still gets lang, so its text reads right to left', () => {
    const container = setup();
    render(container, 'ar', 'ar');
    expect(container.getAttribute('lang')).toBe('ar');
    expect(container.hasAttribute('dir')).toBe(false);
  });
});
