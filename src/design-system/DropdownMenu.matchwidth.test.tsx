// matchAnchorWidth — a menu of USER-WRITTEN titles in a narrow panel. Sized to
// its longest label (the default, right for a list of commands) one long chat
// name made the menu wider than the panel it hangs from and spill over the
// canvas. Opt-in: every other menu must keep sizing to content.
// @vitest-environment jsdom
import { describe, test, expect, afterEach } from 'vitest';
import React, { useRef } from 'react';
import { render, cleanup, screen } from '@testing-library/react';
import DropdownMenu, { type DropdownMenuEntry } from './DropdownMenu';

afterEach(cleanup);

const LONG = 'Here is hero section, reproduce it and do not change anything else on the page please';
const items: DropdownMenuEntry[] = [
  { id: 'a', label: LONG, shortcut: 'now', onClick: () => {} },
  { id: 'b', label: 'Delete this chat', onClick: () => {} },
];

const panelEl = () =>
  document.querySelector('[data-cascading-menu] [role="menu"], [data-cascading-menu] > div:last-child') as HTMLElement;

/** jsdom lays nothing out — give the anchor the width a 260px panel row has. */
function Host({ match, width = 244 }: { match: boolean; width?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <>
      <div
        ref={(el) => {
          ref.current = el;
          if (el) el.getBoundingClientRect = () => ({ x: 8, y: 40, left: 8, top: 40, right: 8 + width, bottom: 68, width, height: 28, toJSON: () => ({}) });
        }}
      />
      <DropdownMenu isOpen onClose={() => {}} items={items} anchorRef={ref} position="bottom-left" matchAnchorWidth={match} minWidth={match ? undefined : 220} />
    </>
  );
}

describe('DropdownMenu matchAnchorWidth', () => {
  test('the menu is exactly as wide as its anchor', () => {
    render(<Host match />);
    expect(panelEl().style.width).toBe('244px');
  });

  test('min-width is dropped — it would let the panel grow past the anchor again', () => {
    render(<Host match />);
    expect(panelEl().style.minWidth).toBe('0px');
  });

  test('a label that does not fit is ellipsized, and still readable in full on hover', () => {
    render(<Host match />);
    const label = screen.getByText(LONG);
    expect(label.className).toContain('truncate');
    expect(label.className).toContain('min-w-0');
    expect(label.getAttribute('title')).toBe(LONG);
  });

  test('follows the anchor — a wider panel gets a wider menu', () => {
    render(<Host match width={380} />);
    expect(panelEl().style.width).toBe('380px');
  });

  test('WITHOUT the option nothing changes: content-sized, no truncation, minWidth honoured', () => {
    render(<Host match={false} />);
    expect(panelEl().style.width).toBe('');
    expect(panelEl().style.minWidth).toBe('220px');
    const label = screen.getByText(LONG);
    expect(label.className).not.toContain('truncate');
    expect(label.getAttribute('title')).toBeNull();
  });
});
