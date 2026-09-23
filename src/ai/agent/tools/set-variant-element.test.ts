// set_variant `element`: from a PAGE, style an element INSIDE a component's
// master for one variant — "in the card's Dark variant, the title is light".
// Before, the page-side write could only reach the master's ROOT, so a
// variant that recolours a card's text was not expressible by any agent.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDefaultStore } from 'jotai';
import { agentToolCall, agentRunEnd } from '@/ai/agent/bridge-tools';
import { projectFS, resetProjectFS } from '@/code/project/project-fs';
import { activeFilePathAtom } from '@/code/project/active-file-store';
import { setActiveFilePath, syncQueueCode, initMutationQueue } from '@/code/mutation/mutation-queue';

const PAGE_PATH = 'app/page.client.tsx';
const PAGE = `'use client';
import Card from '@/components/Card';
export default function Page() {
  return <div data-id="root" style={{ display: 'flex' }}><Card data-id="c1" style={{ position: 'relative' }} /></div>;
}`;
const MASTER = `"use client";
import { withResponsiveProps } from "@revyme/runtime";

/** @name "Card" */
export const variantConfig = [
  { name: 'default', label: 'Default', x: 0, y: 0, isPrimary: true },
  { name: 'dark', label: 'Dark', x: 400, y: 0 },
];

function Card({ style, initialVariant = 'default' }: { style?: React.CSSProperties; initialVariant?: string }) {
  return (
    <div data-id="card-root" style={{ width: 'auto', height: 'auto', ...style }}>
      <h3 data-id="card-title" style={{ width: 'auto', height: 'auto', position: 'relative', margin: '0px', color: '#1a120d' }}>Oat Cortado</h3>
    </div>
  );
}

export default withResponsiveProps(Card);
`;

beforeEach(() => {
  resetProjectFS(new Map([[PAGE_PATH, PAGE], ['components/Card.tsx', MASTER]]));
  getDefaultStore().set(activeFilePathAtom, PAGE_PATH);
  setActiveFilePath(PAGE_PATH);
  initMutationQueue(PAGE, (code) => projectFS.writeFile(PAGE_PATH, code));
  syncQueueCode(PAGE);
});
afterEach(() => { agentRunEnd({}); });

describe('set_variant element — an element inside the master, from the page', () => {
  it('writes the variant style on that element in the master; the page is untouched', async () => {
    const r = await agentToolCall({ name: 'set_variant', input: { node_id: 'c1', variant: 'dark', element: 'card-title', styles: { color: '#fbf6ec' } } });
    expect(r.isError).toBe(false);
    const master = projectFS.readFile('components/Card.tsx')!;
    expect(master).toContain('#fbf6ec');
    // The default look is kept — the dark colour lives on the variant only.
    expect(master).toContain('#1a120d');
    // It landed on the TITLE, not the root: the editor's variant dialect —
    // a variants object for the title, bound to it.
    expect(master).toMatch(/const cardTitleVariants = \{[^}]*default: \{ color: '#1a120d' \}[\s\S]*'dark': \{ color: '#fbf6ec' \}/);
    expect(master).toContain('data-id="card-title" variants={cardTitleVariants}');
    expect(master).not.toMatch(/data-id="card-root"[^>]*variants=/);
    expect(projectFS.readFile(PAGE_PATH)).toBe(PAGE);
  });

  it('an unknown element fails with the master\'s element ids', async () => {
    const r = await agentToolCall({ name: 'set_variant', input: { node_id: 'c1', variant: 'dark', element: 'nope', styles: { color: '#fff' } } });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toContain('card-title');
  });
});
