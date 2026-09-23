// A run's steps share ONE bounded card; a sentence (a new block) or a capture
// breaks it. Structure only — jsdom has no layout, so the scroll-follow is
// exercised by hand in the editor.
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { ActivityList, groupRuns, STEPS_CARD_MAX_ROWS } from './ActivityCard';
import { foldActivity } from './activity';
import type { AgentToolEntry } from '@/code/stores/agent-chat-store';

afterEach(cleanup);

/** Alternating reads and writes never fold together, so N entries = N rows. */
function entries(n: number): AgentToolEntry[] {
  return Array.from({ length: n }, (_, i) => ({ id: `t${i}`, name: i % 2 ? 'set_styles' : 'get_node_tree', ok: true, ms: 1200 }));
}

describe('ActivityList', () => {
  it('puts a long run in ONE card instead of a wall of rows', () => {
    const { container, getAllByTestId } = render(<ActivityList tools={entries(24)} />);
    const cards = getAllByTestId('agent-steps-card');
    expect(cards).toHaveLength(1);
    expect(cards[0].getAttribute('data-rows')).toBe('24');
    // Every row is still there for the reader to scroll to — nothing is dropped.
    expect(container.querySelectorAll('.agent-steps > div')).toHaveLength(24);
    expect(24).toBeGreaterThan(STEPS_CARD_MAX_ROWS);
  });

  it('a capture stands alone and starts a new card after it', () => {
    const tools = [...entries(4), { id: 'shot', name: 'get_screenshot', ok: true, image: 'data:image/png;base64,AAAA' }, ...entries(3)];
    const runs = groupRuns(foldActivity(tools));
    expect(runs.map((r) => r.kind)).toEqual(['steps', 'capture', 'steps']);
    const { getAllByTestId, getAllByAltText } = render(<ActivityList tools={tools} />);
    expect(getAllByTestId('agent-steps-card')).toHaveLength(2);
    expect(getAllByAltText(/screenshot/)).toHaveLength(1);
  });

  it('a live run keeps its LAST row shimmering even between calls', () => {
    // Every call has returned (ok: true) — the model is thinking. The run is
    // still live, so the newest row still moves; nothing else does.
    const { container } = render(<ActivityList tools={entries(6)} live />);
    const live = container.querySelectorAll('.agent-step-live');
    expect(live).toHaveLength(1);
    const rows = container.querySelectorAll('.agent-steps > div');
    expect(rows[rows.length - 1].contains(live[0])).toBe(true);
  });

  it('a finished run has no shimmer at all', () => {
    const { container } = render(<ActivityList tools={entries(6)} />);
    expect(container.querySelectorAll('.agent-step-live')).toHaveLength(0);
  });

  it('when the newest thing is a capture, its label carries the shimmer', () => {
    const tools = [...entries(3), { id: 'shot', name: 'get_screenshot', ok: true, image: 'data:image/png;base64,AAAA' }];
    const { container } = render(<ActivityList tools={tools} live />);
    expect(container.querySelectorAll('.agent-step-live')).toHaveLength(1);
  });
});
