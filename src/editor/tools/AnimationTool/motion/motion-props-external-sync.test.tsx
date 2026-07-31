// motion-props-external-sync.test.tsx — an OPEN MotionPropsEditor must adopt
// props that change from OUTSIDE it (Paste Style on the row, undo) without
// clobbering its own in-flight edits. Live find 2026-07-13: pasting a hover
// style with the Hover popup open only showed after close + reopen.

import { describe, test, expect, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import React from 'react';

// Radix sliders measure via ResizeObserver — jsdom has none.
(globalThis as any).ResizeObserver = (globalThis as any).ResizeObserver ?? class {
  observe() {} unobserve() {} disconnect() {}
};

vi.mock('@/shared/debug-trace', () => ({ trace: { action: vi.fn(), fn: vi.fn(), dom: vi.fn(), error: vi.fn() } }));
// The editor previews onto the canvas bridge — stub the preview helpers.
vi.mock('../preview-inject', () => ({
  applyPreview: vi.fn(), restorePreview: vi.fn(), clearPreview: vi.fn(),
}));

import MotionPropsEditor from './MotionPropsEditor';

function Harness({ props }: { props: Record<string, string> }) {
  return <MotionPropsEditor nodeId="n1" props={props} onChange={() => {}} />;
}

describe('MotionPropsEditor external-change sync', () => {
  test('re-seeds when incoming props change externally (paste with popup open)', async () => {
    const { rerender } = render(<Harness props={{ scale: '1.05' }} />);
    // The Scale row input shows the seeded value.
    expect((screen.getByDisplayValue('1.05') as HTMLInputElement).value).toBe('1.05');

    // Paste lands: the resolved props prop changes from outside the editor.
    await act(async () => { rerender(<Harness props={{ scale: '1.3' }} />); });
    expect(screen.queryByDisplayValue('1.05')).toBeNull();
    expect((screen.getByDisplayValue('1.3') as HTMLInputElement).value).toBe('1.3');
  });

  test('identical round-trip props do NOT reset local state object', async () => {
    const { rerender } = render(<Harness props={{ scale: '1.05' }} />);
    // Same values arriving again (own-commit round-trip) — no visible change,
    // and crucially no crash/reset loop.
    await act(async () => { rerender(<Harness props={{ scale: '1.05' }} />); });
    expect((screen.getByDisplayValue('1.05') as HTMLInputElement).value).toBe('1.05');
  });
});
