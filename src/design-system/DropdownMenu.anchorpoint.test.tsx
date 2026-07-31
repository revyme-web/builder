// anchorPoint positioning — a cursor context menu must open AT the given
// viewport coords. Regression for the panels' right-click menus opening
// ~52px down-right of the mouse: the old implementation used a
// `position: fixed` virtual anchor div INSIDE the row, and the left
// panels' `willChange: 'transform'` made the panel the containing block
// for fixed descendants, re-basing the anchor by the panel's own
// top/left. `anchorPoint` bypasses DOM anchoring entirely.
// @vitest-environment jsdom
import { describe, test, expect, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup } from '@testing-library/react';
import DropdownMenu, { type DropdownMenuEntry } from './DropdownMenu';

afterEach(cleanup);

const items: DropdownMenuEntry[] = [
  { id: 'rename', label: 'Rename', onClick: () => {} },
  { id: 'delete', label: 'Delete', onClick: () => {} },
];

const panelEl = () =>
  document.querySelector('[data-cascading-menu] [role="menu"], [data-cascading-menu] > div:last-child') as HTMLElement;

describe('DropdownMenu anchorPoint', () => {
  test('bottom-left menu opens at the cursor point (left = x, top = y + gap)', () => {
    render(
      <DropdownMenu
        isOpen
        onClose={() => {}}
        items={items}
        anchorPoint={{ x: 300, y: 400 }}
        position="bottom-left"
      />,
    );
    const panel = panelEl();
    expect(panel).toBeTruthy();
    // jsdom rects are 0×0, so no viewport clamping kicks in — the layout
    // effect must land the panel exactly at the point (+4px gap below).
    expect(panel.style.left).toBe('300px');
    expect(panel.style.top).toBe('404px');
  });

  test('a second right-click re-positions to the new point', () => {
    const { rerender } = render(
      <DropdownMenu isOpen onClose={() => {}} items={items} anchorPoint={{ x: 100, y: 120 }} position="bottom-left" />,
    );
    rerender(
      <DropdownMenu isOpen onClose={() => {}} items={items} anchorPoint={{ x: 250, y: 60 }} position="bottom-left" />,
    );
    const panel = panelEl();
    expect(panel.style.left).toBe('250px');
    expect(panel.style.top).toBe('64px');
  });

  test('without anchorPoint and with no anchorRef the menu stays unpositioned (no crash)', () => {
    render(<DropdownMenu isOpen onClose={() => {}} items={items} position="bottom-left" />);
    expect(panelEl()).toBeTruthy();
  });
});
