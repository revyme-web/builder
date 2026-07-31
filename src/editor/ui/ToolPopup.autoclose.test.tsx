// Auto-close on empty content — a popup whose active panel renders NOTHING
// is editing an entity that no longer exists (an undo removed the sort rule
// / mask entry while its editor was open). The shell must not linger as an
// empty titled box (the Collection List "Order" popup report).
// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import React, { useRef } from 'react';
import { render, cleanup, act } from '@testing-library/react';
import ToolPopup from './ToolPopup';

// jsdom has no ResizeObserver — ToolPopup's height-measure effect needs a stub.
class RO { observe() {} unobserve() {} disconnect() {} }
(globalThis as unknown as { ResizeObserver: typeof RO }).ResizeObserver = RO;

afterEach(cleanup);

function Host({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  const anchorRef = useRef<HTMLDivElement>(null);
  return (
    <div>
      <div ref={anchorRef} />
      <ToolPopup isOpen onClose={onClose} title="Order" anchorRef={anchorRef}>
        {children}
      </ToolPopup>
    </div>
  );
}

const Gone = () => null;

describe('ToolPopup auto-close on empty content', () => {
  it('closes when the content renders nothing', async () => {
    let closed = 0;
    await act(async () => {
      render(<Host onClose={() => { closed++; }}><Gone /></Host>);
    });
    expect(closed).toBeGreaterThan(0);
  });

  it('stays open when the content has real children', async () => {
    let closed = 0;
    await act(async () => {
      render(<Host onClose={() => { closed++; }}><div>Sort by</div></Host>);
    });
    expect(closed).toBe(0);
  });
});
