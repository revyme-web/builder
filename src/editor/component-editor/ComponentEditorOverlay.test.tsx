// Stale-buffer protection: an Edit Code overlay left open across an EXTERNAL
// file write (MCP submit, Vibe, collab) must never resurrect its old buffer
// (the "locale switcher reverted AGAIN" clobber, 2026-07-22).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { getDefaultStore } from 'jotai';
import { projectFS, resetProjectFS, projectVersionAtom } from '@/code/project/project-fs';
import { componentEditorFileAtom } from '@/code/stores/component-editor-store';
import ComponentEditorOverlay from './ComponentEditorOverlay';
import { runBeforeAgentTurn } from '@/ai/agent/turn-hooks';

vi.mock('./ComponentCodePane', () => ({
  default: ({ onChange }: { onChange: (c: string) => void }) => (
    <button data-testid="type-local" onClick={() => onChange('LOCAL EDIT')}>type</button>
  ),
}));
vi.mock('./ComponentPreviewPane', () => ({ default: () => null }));
vi.mock('./ComponentPropsPanel', () => ({ default: () => null }));
vi.mock('@/editor/agent/AgentChat', () => ({ default: () => null }));

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

// The agent reads FILES; this overlay edits a BUFFER. The chat runs the
// before-turn hooks so the two agree before the agent looks.
describe('ComponentEditorOverlay ↔ the agent', () => {
  it('writes the user\'s unsaved typing out before a turn, so the agent reads what they see', () => {
    render(<ComponentEditorOverlay />);
    act(() => { store.set(componentEditorFileAtom, FILE); });
    fireEvent.click(screen.getByTestId('type-local'));
    expect(projectFS.readFile(FILE)).toBe('ORIGINAL');       // typing alone saves nothing

    act(() => { runBeforeAgentTurn(); });
    expect(projectFS.readFile(FILE)).toBe('LOCAL EDIT');
  });

  // THE CONTRACT THAT MATTERS: type → ask → the agent's write must WIN. Without
  // the pre-turn save the buffer still counts as "edited", the overlay keeps
  // it over the agent's file (external-conflict), and close writes the OLD
  // typing back over what the agent just did.
  it('type → ask → agent writes: the overlay adopts the agent\'s file and close does not clobber it', () => {
    render(<ComponentEditorOverlay />);
    act(() => { store.set(componentEditorFileAtom, FILE); });
    fireEvent.click(screen.getByTestId('type-local'));

    act(() => { runBeforeAgentTurn(); });                     // the chat, on send
    externalWrite('WRITTEN BY THE AGENT');                    // apply_file_edit lands
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(projectFS.readFile(FILE)).toBe('WRITTEN BY THE AGENT');
  });

  it('an unedited buffer writes nothing — it must not resurrect a stale copy over a newer file', () => {
    render(<ComponentEditorOverlay />);
    act(() => { store.set(componentEditorFileAtom, FILE); });
    const writes = vi.spyOn(projectFS, 'writeFile');
    act(() => { runBeforeAgentTurn(); });
    expect(writes).not.toHaveBeenCalled();
    writes.mockRestore();
  });

  it('stops listening once the overlay is closed', () => {
    render(<ComponentEditorOverlay />);
    act(() => { store.set(componentEditorFileAtom, FILE); });
    fireEvent.click(screen.getByTestId('type-local'));
    fireEvent.keyDown(window, { key: 'Escape' });             // close saves LOCAL EDIT
    act(() => { projectFS.writeFile(FILE, 'LATER, ELSEWHERE'); });
    act(() => { runBeforeAgentTurn(); });
    expect(projectFS.readFile(FILE)).toBe('LATER, ELSEWHERE');
  });
});
