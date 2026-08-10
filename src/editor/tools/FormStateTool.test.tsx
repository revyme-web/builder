/** @vitest-environment jsdom */
// FormStateTool.test.tsx — panel shape of the Form State section.
//
// Two user reports (2026-08-10), both about how the section READS rather than
// what it does:
//   · the trailing "×" on each row floated in the panel gutter — RemoveButton is
//     sized for a full-width ControlActionRow (the Overlay pill), and beside a
//     select it just shrinks the control and leaves a bare glyph.
//   · the section had no trailing divider, so Component Props ran straight into
//     it. Every other tool owns its own ToolDivider.
//
// Unmapping still has to be reachable — it moved INTO the dropdown, so these
// tests pin that it didn't simply disappear.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { createStore, Provider, type PrimitiveAtom } from 'jotai';
import React from 'react';

const queued: unknown[] = [];
vi.mock('@/code/mutation/mutation-queue', () => ({
  queueMutation: (m: unknown) => queued.push(m),
  flushNow: vi.fn(),
}));
vi.mock('@/shared/debug-trace', () => ({
  trace: { action: vi.fn(), fn: vi.fn(), dom: vi.fn(), error: vi.fn() },
}));
vi.mock('@/code/project/project-fs', () => ({
  projectFS: {
    readFile: () => `const variantConfig = [
  { name: 'default', label: 'Default', isPrimary: true },
  { name: 'loading', label: 'Loading' },
  { name: 'success', label: 'Success' },
];`,
  },
}));

// Plain atoms: the real codeAtom/selectedNodeAtom are write-THROUGH (they push
// into ProjectFS and bump projectVersionAtom). This tool only READS them, and
// the test is about the rendered panel, not the store plumbing.
vi.mock('@/code/stores/store', async () => {
  const { atom } = await import('jotai');
  return { codeAtom: atom(''), selectedNodeAtom: atom<string | null>(null) };
});

const NODE = {
  id: 'btn', type: 'FormSubmit', parentId: 'form-1',
  componentFile: 'components/FormSubmit.tsx',
};
const NODES = new Map<string, Record<string, unknown>>([
  ['form-1', { id: 'form-1', type: 'form', parentId: 'root' }],
  ['btn', NODE],
]);
vi.mock('@/code/stores/node-family', () => ({
  useNode: () => NODE,
  useNodesComputed: (fn: (n: Map<string, unknown>) => unknown) => fn(NODES as never),
}));

import { codeAtom, selectedNodeAtom } from '@/code/stores/store';
import FormStateTool from './FormStateTool';

const CODE = `<FormSubmit data-id="btn" data-form-state='{"loading":"loading","success":"success"}' />`;

function renderTool(code = CODE) {
  const store = createStore();
  // The real atoms are write-through; these are the plain stand-ins mocked
  // above, so the cast just tells TS what the mock actually is.
  store.set(codeAtom as unknown as PrimitiveAtom<string>, code);
  store.set(selectedNodeAtom as unknown as PrimitiveAtom<string | null>, 'btn');
  return render(<Provider store={store}><FormStateTool /></Provider>);
}

beforeEach(() => { queued.length = 0; });

describe('Form State section', () => {
  it('renders a row per mapped state', () => {
    renderTool();
    // Each name appears twice: the row LABEL and an <option> in the dropdown.
    expect(screen.getAllByText('Loading').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Success').length).toBeGreaterThan(0);
    expect(screen.getAllByRole('combobox').length).toBe(2);
  });

  it('has NO stray × remove button', () => {
    const { container } = renderTool();
    expect(container.textContent).not.toContain('×');
    expect(container.textContent).not.toContain('×');
  });

  it('ends with a divider so Component Props is separated', () => {
    const { container } = renderTool();
    // ToolDivider is the last element the tool renders.
    const last = container.lastElementChild;
    expect(last, 'the tool must render a trailing divider').toBeTruthy();
    expect(container.innerHTML).toMatch(/border|divider|<hr/i);
  });

  it('still lets you UNMAP — via the dropdown, not a ×', () => {
    renderTool();
    const selects = screen.getAllByRole('combobox');
    expect(selects.length).toBe(2);
    // "Not mapped" is offered on every row.
    expect(screen.getAllByText('Not mapped').length).toBe(2);
    fireEvent.change(selects[0], { target: { value: '' } });
    expect(queued.length).toBe(1);
    const m = queued[0] as { type: string; mapping: Record<string, string> };
    expect(m.type).toBe('setFormStateMapping');
    expect(m.mapping.loading, 'loading must be unmapped').toBeUndefined();
    expect(m.mapping.success, 'success must survive').toBe('success');
  });

  it('changing the variant rewrites only that state', () => {
    renderTool();
    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'success' } });
    const m = queued[0] as { mapping: Record<string, string> };
    expect(m.mapping).toEqual({ loading: 'success', success: 'success' });
  });
});
