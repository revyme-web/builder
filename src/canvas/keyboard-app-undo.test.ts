// keyboard-app-undo.test.ts — Cmd+Z must survive a focused text field on
// surfaces that opt in with `data-app-undo`.
//
// KeyboardManager bails on INPUT/TEXTAREA so canvas shortcuts can't fire while
// typing. That is right for Delete and the arrow keys and wrong for undo: in
// the Manage Translations overlay the user types a translation, commits it,
// and Cmd+Z did nothing because focus was still in the textarea (user report
// 2026-08-09). The opt-in keeps the guard for every other key.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/shared/debug-trace', () => ({
  trace: { action: vi.fn(), fn: vi.fn(), dom: vi.fn(), error: vi.fn() },
}));

import { keyboard } from './KeyboardManager';

const press = (key: string, opts: { meta?: boolean; shift?: boolean } = {}) => {
  window.dispatchEvent(new KeyboardEvent('keydown', {
    key, metaKey: opts.meta ?? true, shiftKey: opts.shift ?? false, bubbles: true, cancelable: true,
  }));
};

/** Focus a field, optionally inside a surface that opts into app undo. */
function focusField(tag: 'textarea' | 'input', optIn: boolean): HTMLElement {
  const host = document.createElement('div');
  if (optIn) host.setAttribute('data-app-undo', '');
  const field = document.createElement(tag);
  host.appendChild(field);
  document.body.appendChild(host);
  field.focus();
  return field;
}

describe('undo/redo from an opted-in text field', () => {
  let undoFired: number;
  let deleteFired: number;
  let cleanups: Array<() => void>;
  let stopListening: () => void;

  beforeEach(() => {
    document.body.innerHTML = '';
    undoFired = 0;
    deleteFired = 0;
    cleanups = [
      keyboard.register({ key: 'z', ctrl: true, label: 'Undo', category: 'general', handler: () => { undoFired++; } }),
      keyboard.register({ key: 'Delete', label: 'Delete', category: 'general', handler: () => { deleteFired++; } }),
    ];
    stopListening = keyboard.listen();
  });

  afterEach(() => {
    cleanups.forEach(fn => fn());
    stopListening();
    document.body.innerHTML = '';
  });

  it('fires inside a [data-app-undo] textarea', () => {
    focusField('textarea', true);
    press('z');
    expect(undoFired).toBe(1);
  });

  it('still does NOT fire in a plain textarea', () => {
    // TipTap and Monaco live here: their own undo is the meaningful one.
    focusField('textarea', false);
    press('z');
    expect(undoFired).toBe(0);
  });

  it('opting in does not open the field to OTHER shortcuts', () => {
    // The whole point of the text-field guard. Delete inside a translation
    // cell must delete a character, never the selected node.
    focusField('textarea', true);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }));
    expect(deleteFired).toBe(0);
  });

  it('needs the modifier — a bare "z" is typing', () => {
    focusField('textarea', true);
    press('z', { meta: false });
    expect(undoFired).toBe(0);
  });

  it('applies to inputs too, not just textareas', () => {
    focusField('input', true);
    press('z');
    expect(undoFired).toBe(1);
  });

  it('works from anywhere in the subtree, not just a direct child', () => {
    const host = document.createElement('div');
    host.setAttribute('data-app-undo', '');
    const mid = document.createElement('div');
    const field = document.createElement('textarea');
    mid.appendChild(field); host.appendChild(mid); document.body.appendChild(host);
    field.focus();
    press('z');
    expect(undoFired).toBe(1);
  });
});
