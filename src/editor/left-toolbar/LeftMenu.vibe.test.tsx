// The VIBE icon shows the agent is WORKING from any panel — the working
// class (ring, grid, scanline, glitch — globals.css) is on exactly while the
// run is, so the reader never has to be on the chat to know.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { getDefaultStore } from 'jotai';
import { agentStatusAtom } from '@/code/stores/agent-chat-store';

vi.mock('@/editor/collab/CollaboratorsModal', () => ({ default: () => null }));
vi.mock('@/editor/collab/CollaboratorsSection', () => ({ default: () => null }));

import LeftMenu from './LeftMenu';

const store = getDefaultStore();
afterEach(() => { cleanup(); act(() => { store.set(agentStatusAtom, 'idle'); }); });

describe('VIBE icon while the agent runs', () => {
  it('carries the working animation only while a run is live', () => {
    const { getByTestId } = render(<LeftMenu />);
    const vibe = getByTestId('vibe-button');
    expect(vibe.classList.contains('vibe-working')).toBe(false);
    act(() => { store.set(agentStatusAtom, 'running'); });
    expect(vibe.classList.contains('vibe-working')).toBe(true);
    expect(vibe.getAttribute('data-working')).toBe('true');
    act(() => { store.set(agentStatusAtom, 'idle'); });
    expect(vibe.classList.contains('vibe-working')).toBe(false);
  });
});
