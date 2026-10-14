// bridge-tools.agents.test.ts — one agent at a time, and "done" means saved.
//
// 2026-10-14: four clients on one project (Claude.ai, Cursor, Claude Code, an
// orchestrator) shared the editor's single run — each begin_work silently
// ended the previous agent's run and finish_work reported "0 file(s)
// changed"; and agent writes were reported done while the backend refused
// every save.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const saveState = vi.hoisted(() => ({
  outcome: { ok: true } as { ok: true } | { ok: false; error: string; conflict?: boolean },
  flushes: 0,
}));
// apply_file_edit's oracle gate, stubbed to a clean pass whose commit writes
// ProjectFS for real — the write the save must follow.
const gateState = vi.hoisted(() => ({ write: null as null | ((path: string, code: string) => void) }));
vi.mock('@/code/oracle/gate', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/code/oracle/gate')>();
  return {
    ...real,
    gateTurnFiles: vi.fn((files: Array<{ path: string; code: string }>) => ({ files, violations: [] })),
    commitTurnFiles: vi.fn((files: Array<{ path: string; code: string }>) => {
      for (const f of files) gateState.write?.(f.path, f.code);
      return files.map((f) => f.path);
    }),
  };
});
vi.mock('@/backend/autosave', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/backend/autosave')>();
  return {
    ...real,
    triggerAutosave: vi.fn(),
    flushSaveNow: vi.fn(async () => { saveState.flushes++; return saveState.outcome; }),
  };
});

import { agentToolCall, agentRunStart, agentRunEnd, agentRunEndAndSave } from './bridge-tools';
import { resetProjectFS, projectFS } from '@/code/project/project-fs';
import { getDefaultStore } from 'jotai';
import { activeFilePathAtom } from '@/code/project/active-file-store';
import { setActiveFilePath, syncQueueCode } from '@/code/mutation/mutation-queue';

const PAGE = `'use client';
import React from 'react';
export default function Page() {
  return (<div data-id="root" data-name="Page" style={{ position: 'relative' }}>
    <div data-id="box" data-name="Box" style={{ position: 'relative' }}></div>
  </div>);
}`;

beforeEach(() => {
  resetProjectFS(new Map([['app/page.client.tsx', PAGE]]));
  getDefaultStore().set(activeFilePathAtom, 'app/page.client.tsx');
  setActiveFilePath('app/page.client.tsx');
  syncQueueCode(PAGE);
  saveState.outcome = { ok: true };
  saveState.flushes = 0;
  gateState.write = (path, code) => projectFS.writeFile(path, code);
});
afterEach(() => { agentRunEnd({}); });

const text = (r: { content: unknown[] }) => JSON.stringify(r.content);

describe('one agent at a time', () => {
  it('a second client\'s begin_work is refused while the first one\'s run is open', () => {
    agentRunStart({ runId: 'run-a', source: 'mcp', client: 'claude-code', request: 'hero copy' });
    expect(() => agentRunStart({ runId: 'run-b', source: 'mcp', client: 'cursor' }))
      .toThrow(/another agent \(claude-code\) is working/);
    // The first run is untouched.
    expect(agentRunEnd({ runId: 'run-a' }).runId).toBe('run-a');
  });

  it('the same client starting its next request ends its own previous run', () => {
    agentRunStart({ runId: 'run-a', source: 'mcp', client: 'claude-code' });
    expect(agentRunStart({ runId: 'run-a2', source: 'mcp', client: 'claude-code' }).runId).toBe('run-a2');
  });

  it('a tool call from another agent cannot write into the open run', async () => {
    agentRunStart({ runId: 'run-a', source: 'mcp', client: 'claude-code' });
    const r = await agentToolCall({ name: 'get_node_tree', input: {}, runId: 'run-b', client: 'cursor' });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('Refused');
  });

  it('a lazy caller (no begin_work) from another client is refused too', async () => {
    agentRunStart({ runId: 'run-a', source: 'mcp', client: 'claude-code' });
    const r = await agentToolCall({ name: 'get_node_tree', input: {}, client: 'cursor' });
    expect(r.isError).toBe(true);
  });

  it('the run\'s own calls go through', async () => {
    agentRunStart({ runId: 'run-a', source: 'mcp', client: 'claude-code' });
    const r = await agentToolCall({ name: 'get_node_tree', input: {}, runId: 'run-a', client: 'claude-code' });
    expect(r.isError).toBe(false);
  });

  it('finish_work with a run id that is no longer open never ends another agent\'s run', () => {
    agentRunStart({ runId: 'run-a', source: 'mcp', client: 'claude-code' });
    expect(agentRunEnd({ runId: 'run-old' }).runId).toBeNull();
    expect(agentRunEnd({ runId: 'run-a' }).runId).toBe('run-a');
  });
});

describe('an external agent hears "done" only once it is saved', () => {
  const write = (runId: string) => agentToolCall({
    name: 'apply_file_edit', input: { path: 'app/page.client.tsx', kind: 'page', code: PAGE.replace('Box', 'Card') }, runId, client: 'claude-code',
  });

  it('a write whose save failed comes back as an error saying it is NOT persisted', async () => {
    agentRunStart({ runId: 'run-a', source: 'mcp', client: 'claude-code' });
    saveState.outcome = { ok: false, error: 'Save failed: 500 Server has closed the connection' };
    const r = await write('run-a');
    expect(saveState.flushes).toBeGreaterThan(0);
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('NOT persisted');
  });

  it('a write that saved is a normal result', async () => {
    agentRunStart({ runId: 'run-a', source: 'mcp', client: 'claude-code' });
    const r = await write('run-a');
    expect(r.isError).toBe(false);
    expect(saveState.flushes).toBeGreaterThan(0);
  });

  it('a read does not trigger a save', async () => {
    agentRunStart({ runId: 'run-a', source: 'mcp', client: 'claude-code' });
    await agentToolCall({ name: 'get_node_tree', input: {}, runId: 'run-a', client: 'claude-code' });
    expect(saveState.flushes).toBe(0);
  });

  it('run end reports a failed save instead of a clean finish', async () => {
    agentRunStart({ runId: 'svc-1' });
    await agentToolCall({ name: 'apply_file_edit', input: { path: 'app/page.client.tsx', kind: 'page', code: PAGE.replace('Box', 'Tile') }, runId: 'svc-1' });
    // The chat's own run does not save per call — only at run end.
    expect(saveState.flushes).toBe(0);
    saveState.outcome = { ok: false, error: 'Save failed: 500' };
    const ended = await agentRunEndAndSave({ runId: 'svc-1' });
    expect(ended.runId).toBe('svc-1');
    expect(ended.saved?.ok).toBe(false);
  });
});
