// Stale-buffer protection: an Edit Code overlay left open across an EXTERNAL
// file write (MCP submit, Vibe, collab) must never resurrect its old buffer
// (the "locale switcher reverted AGAIN" clobber, 2026-07-22).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { getDefaultStore } from 'jotai';
import { projectFS, resetProjectFS, projectVersionAtom } from '@/code/project/project-fs';
import { componentEditorFileAtom } from '@/code/stores/component-editor-store';
import ComponentEditorOverlay from './ComponentEditorOverlay';

vi.mock('./ComponentCodePane', () => ({
  default: ({ onChange }: { onChange: (c: string) => void }) => (
    <button data-testid="type-local" onClick={() => onChange('LOCAL EDIT')}>type</button>
  ),
}));
vi.mock('./ComponentPreviewPane', () => ({ default: () => null }));
vi.mock('./ComponentPropsPanel', () => ({ default: () => null }));
vi.mock('./ComponentChat', () => ({ default: () => null }));

const FILE = 'components/Widget.tsx';
const store = getDefaultStore();

function externalWrite(content: string) {
  act(() => {
    projectFS.writeFile(FILE, content);
    store.set(projectVersionAtom, store.get(projectVersionAtom) + 1);
  });
}

beforeEach(() => {
  resetProjectFS(new Map([[FILE, 'ORIGINAL']]));
  act(() => { store.set(componentEditorFileAtom, null); });
});

describe('ComponentEditorOverlay external-change safety', () => {
  it('unedited overlay adopts an external write and does NOT clobber on close', async () => {
    render(<ComponentEditorOverlay />);
    act(() => { store.set(componentEditorFileAtom, FILE); });

    externalWrite('NEW FROM MCP');
    // Close via Escape — the old buffer must not be written back.
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(projectFS.readFile(FILE)).toBe('NEW FROM MCP');
  });

  it('locally-edited overlay keeps the user edits on close (traced conflict)', async () => {
    render(<ComponentEditorOverlay />);
    act(() => { store.set(componentEditorFileAtom, FILE); });

    fireEvent.click(screen.getByTestId('type-local'));
    externalWrite('NEW FROM MCP');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(projectFS.readFile(FILE)).toBe('LOCAL EDIT');
  });

  it('plain local edit still saves on close (no external change)', async () => {
    render(<ComponentEditorOverlay />);
    act(() => { store.set(componentEditorFileAtom, FILE); });

    fireEvent.click(screen.getByTestId('type-local'));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(projectFS.readFile(FILE)).toBe('LOCAL EDIT');
  });
});
