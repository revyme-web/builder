// preset-detach.test.ts — deleting a preset through the mutation queue (the
// path every delete takes: panel, pickers, agent, MCP) keeps each element's
// look. Before: `var(--color-surface)` stayed in the fill with no token behind
// it (user report 2026-10-21).
import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.mock('@/shared/debug-trace', () => ({
  trace: { action: vi.fn(), fn: vi.fn(), dom: vi.fn(), error: vi.fn(), getEntries: () => [] },
}));

import { getDefaultStore } from 'jotai';
import { projectFS, resetProjectFS } from './project-fs';
import { activeFilePathAtom } from './active-file-store';
import { initMutationQueue, queueMutation, flushNow } from '../mutation/mutation-queue';

const GLOBALS = `:root {
  /* Colors */
  --color-surface: #ffffff;
  --color-surface-dark: #0f0f1a;
  --color-card: var(--color-surface);
  /* Typography */
  --typo-heading-font: 'Inter', sans-serif;
}

:root.dark {
  --color-surface: #0f0f1a;
}
`;

const PAGE = `<div data-id="root" style={{ position: 'relative', width: '1440px', backgroundColor: 'var(--color-surface)' }}>
  <p data-id="t" style={{ position: 'relative', color: 'var(--color-surface-dark)', fontFamily: 'var(--typo-heading-font)' }}>Hi</p>
</div>`;

describe('removePresetToken detaches every usage first', () => {
  let flushed: string;
  beforeEach(() => {
    resetProjectFS();
    projectFS.writeFile('app/globals.css', GLOBALS);
    projectFS.writeFile('app/page.client.tsx', PAGE);
    projectFS.writeFile('components/Card.tsx', `export default function Card() { return <div data-id="c" style={{ borderColor: 'var(--color-surface)' }} />; }\n`);
    getDefaultStore().set(activeFilePathAtom, 'app/page.client.tsx');
    flushed = '';
    initMutationQueue(PAGE, (code) => { flushed = code; }, () => {}, () => {});
  });

  test('a colour: the active page, other files and dependent tokens keep the value', () => {
    queueMutation({ type: 'removePresetToken', name: 'color-surface' });
    flushNow();
    // active page — through the queue's code, not a direct write
    expect(flushed).toContain("backgroundColor: '#ffffff'");
    expect(flushed).toContain("color: 'var(--color-surface-dark)'");
    // another file
    expect(projectFS.readFile('components/Card.tsx')).toContain("borderColor: '#ffffff'");
    const css = projectFS.readFile('app/globals.css') ?? '';
    expect(css).not.toMatch(/--color-surface\s*:/); // light AND dark declarations gone
    expect(css).toContain('--color-card: #ffffff;');
    expect(css).toContain('--color-surface-dark: #0f0f1a;');
  });

  test('a font stack with quotes keeps the page parseable', () => {
    queueMutation({ type: 'removePresetToken', name: 'typo-heading-font' });
    flushNow();
    expect(flushed).toContain(`fontFamily: "'Inter', sans-serif"`);
  });
});
