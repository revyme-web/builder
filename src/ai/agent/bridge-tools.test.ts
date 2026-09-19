import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { agentToolManifest, agentToolCall, agentRunStart, agentRunEnd, agentRunAbort } from './bridge-tools';
import { projectFS, resetProjectFS, MAIN_BRANCH_ID } from '@/code/project/project-fs';
import { isBranchLocked } from '@/code/stores/agent-run-lock-store';
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

describe('agent bridge tools', () => {
  beforeEach(() => {
    resetProjectFS(new Map([['app/page.client.tsx', PAGE]]));
    // The queue splices into the ACTIVE file's code — point both the editor
    // and the queue at the page, exactly as opening it in the builder does.
    getDefaultStore().set(activeFilePathAtom, 'app/page.client.tsx');
    setActiveFilePath('app/page.client.tsx');
    syncQueueCode(PAGE);
  });
  afterEach(() => { agentRunEnd({}); });

  it('serves a transport-safe manifest', () => {
    const { tools } = agentToolManifest();
    expect(tools.length).toBeGreaterThan(20);
    expect(JSON.parse(JSON.stringify(tools))).toEqual(tools);
  });

  it('an unknown tool answers with the valid names instead of throwing', async () => {
    const r = await agentToolCall({ name: 'nope', input: {} });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toContain('Available');
  });

  it('bad arguments come back as a teaching error, never a transport throw', async () => {
    const r = await agentToolCall({ name: 'set_styles', input: { nope: 1 } });
    expect(r.isError).toBe(true);
    expect(Array.isArray(r.content)).toBe(true);
  });

  it('a read tool executes against the live project', async () => {
    const r = await agentToolCall({ name: 'get_node_tree', input: {} });
    expect(r.isError).toBe(false);
    expect(JSON.stringify(r.content)).toContain('root');
  });

  it('run_start locks the active branch and run_end releases it', () => {
    const { runId, branch } = agentRunStart({});
    expect(branch).toBe(MAIN_BRANCH_ID);
    expect(isBranchLocked(MAIN_BRANCH_ID)).toBe(true);
    const end = agentRunEnd({ runId });
    expect(end.runId).toBe(runId);
    expect(isBranchLocked(MAIN_BRANCH_ID)).toBe(false);
  });

  it('a mutating tool executes and the run seals cleanly', async () => {
    // What this layer owns: dispatch → validate → execute → seal. The actual
    // file write happens in the mutation queue's drain, which needs the
    // editor's live wiring (codeAtom / node cache) — the tool suites cover
    // that with their own harness. Here we assert the bridge contract.
    const { runId } = agentRunStart({});
    const r = await agentToolCall({
      name: 'set_styles',
      input: { node_id: 'box', styles: { backgroundColor: '#ff0000' } },
      runId,
    });
    expect(r.isError).toBe(false);
    expect(JSON.stringify(r.content)).toContain('applied');
    const end = agentRunEnd({ runId });
    expect(end.runId).toBe(runId);
    expect(Array.isArray(end.changes)).toBe(true);
    expect(isBranchLocked(MAIN_BRANCH_ID)).toBe(false);   // lock always released
  });

  it('a tool call with no open run opens one implicitly', async () => {
    const r = await agentToolCall({ name: 'get_node_tree', input: {} });
    expect(r.isError).toBe(false);
    expect(isBranchLocked(MAIN_BRANCH_ID)).toBe(true);   // run was opened
  });

  it('abort reports whether a run was in flight', () => {
    expect(agentRunAbort().aborted).toBe(false);
    agentRunStart({});
    expect(agentRunAbort().aborted).toBe(true);
  });

  it('run_end with no run is a no-op, not a throw', () => {
    expect(agentRunEnd({})).toEqual({ runId: null, changes: [] });
  });
});
