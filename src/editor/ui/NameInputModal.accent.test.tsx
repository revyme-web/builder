// NameInputModal.accent.test.tsx — the accent fill and its label travel together.
//
// User report 2026-08-08: the New Template modals (Template tool + Library
// panel) showed the primary khaki accent instead of the purple component-system
// one. Templates share the component accent everywhere else in the app.
//
// The underlying footgun: `accentColor` and `accentFg` were two independent
// props with a doc-comment rule that overriding one meant overriding the other.
// Every call site set only the fill, so the purple button carried the near-black
// `--accent-fg` label. One `accent` variant now sets both.

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import NameInputModal from './NameInputModal';

const open = (props: Partial<React.ComponentProps<typeof NameInputModal>> = {}) =>
  render(
    <NameInputModal
      isOpen
      onClose={() => {}}
      onSubmit={() => {}}
      title="New Template"
      submitLabel="Create"
      {...props}
    />,
  );

describe('NameInputModal accent', () => {
  it('secondary uses the purple fill AND the white label', () => {
    open({ accent: 'secondary' });
    const btn = screen.getByRole('button', { name: 'Create' });
    expect(btn.style.backgroundColor).toContain('--accent-secondary');
    expect(btn.style.color).toContain('--accent-secondary-fg');
    // The near-black primary label must not leak onto the purple fill.
    expect(btn.style.color).not.toContain('--accent-fg,');
    expect(btn.style.color).not.toBe('var(--accent-fg)');
  });

  it('primary is the default and keeps the section accent', () => {
    open();
    const btn = screen.getByRole('button', { name: 'Create' });
    expect(btn.style.backgroundColor).toContain('--accent,');
    expect(btn.style.color).toBe('var(--accent-fg)');
  });

  it('publishes the accent to the whole dialog, not just the button', () => {
    open({ accent: 'secondary' });
    const input = screen.getByPlaceholderText('Enter name...');
    // The focus ring reads the same var, so it follows the accent too.
    expect(input.className).toContain('focus:border-[var(--modal-accent)]');
    const body = input.parentElement!;
    expect(body.style.getPropertyValue('--modal-accent')).toContain('--accent-secondary');
    expect(body.style.getPropertyValue('--modal-accent-fg')).toContain('--accent-secondary-fg');
  });

  it('an explicit colour still wins (the destructive escape hatch)', () => {
    open({ accentColor: '#ef4444', accentFg: '#fff' });
    const btn = screen.getByRole('button', { name: 'Create' });
    expect(btn.style.backgroundColor).toBe('rgb(239, 68, 68)');
    expect(btn.style.color).toBe('rgb(255, 255, 255)');
  });
});

// ─── Dismiss semantics ──────────────────────────────────────────────────────
//
// User report 2026-08-08: in the Library panel's "Name Template" dialog,
// clicking Create with the MOUSE dismissed it without creating, while Enter
// worked. A `click` fires on the nearest common ancestor of the mousedown and
// mouseup targets, so anything that re-renders or reflows the button mid-press
// resolves the click on the backdrop — and the backdrop's job was to dismiss.
// A press that BEGAN inside the dialog is never a dismiss.

import { fireEvent } from '@testing-library/react';
import { vi } from 'vitest';

describe('CompactModalShell dismiss', () => {
  it('submits when the press starts on the button, even if the click resolves on the backdrop', () => {
    const onSubmit = vi.fn();
    const onClose = vi.fn();
    const { container } = render(
      <NameInputModal isOpen onClose={onClose} onSubmit={onSubmit} title="Name Template" submitLabel="Create Template" />,
    );
    const input = screen.getByPlaceholderText('Enter name...');
    fireEvent.change(input, { target: { value: 'zefez' } });

    const btn = screen.getByRole('button', { name: 'Create Template' });
    fireEvent.mouseDown(btn);
    fireEvent.click(btn);
    expect(onSubmit).toHaveBeenCalledWith('zefez');

    // The same gesture must not ALSO be read as a backdrop dismiss: replay the
    // click on the shell root, which is where a mid-press re-render sends it.
    onClose.mockClear();
    const root = container.ownerDocument.body.querySelector('[style*="99999"]') as HTMLElement;
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Create Template' }));
    fireEvent.click(root);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('still dismisses on a press that starts on the backdrop', () => {
    const onClose = vi.fn();
    const { container } = render(
      <NameInputModal isOpen onClose={onClose} onSubmit={() => {}} title="Name Template" submitLabel="Create" />,
    );
    const root = container.ownerDocument.body.querySelector('[style*="99999"]') as HTMLElement;
    fireEvent.mouseDown(root);
    fireEvent.click(root);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not leak the press to document-level outside-click listeners', () => {
    const outside = vi.fn();
    document.addEventListener('mousedown', outside);
    try {
      render(<NameInputModal isOpen onClose={() => {}} onSubmit={() => {}} title="Name Template" submitLabel="Create" />);
      fireEvent.mouseDown(screen.getByPlaceholderText('Enter name...'));
      expect(outside).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('mousedown', outside);
    }
  });
});
