import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { agentToolManifest, agentToolCall, agentRunStart, agentRunEnd, agentRunAbort, LAZY_RUN_IDLE_MS } from './bridge-tools';
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

describe('agent bridge — post-write oracle report (every write path is judged)', () => {
  it('a semantic write that introduces a dialect violation carries `oracle` rows; a crash-class one is an error', async () => {
    const { seedWorld } = await import('./capability/harness');
    const { flushNow } = await import('@/code/mutation/mutation-queue');
    seedWorld({});
    agentRunStart({ runId: 'oracle-report' });
    try {
      // Tier-3 but flow-level: a form BEFORE its destination is a step, not a broken file.
      const form = await agentToolCall({ name: 'add_node', input: { parent_id: 'hero', tag: 'form', id: 'f1', styles: { display: 'flex', flexDirection: 'column' } }, runId: 'oracle-report' });
      const formReply = JSON.parse((form.content[0] as { text: string }).text);
      expect(form.isError).toBe(false);
      expect(formReply.oracle?.some((r: { code: string }) => r.code === 'FORM_NO_DESTINATION')).toBe(true);
      expect(formReply.oracle[0].fix).toMatch(/data-form/);
      // A clean write carries no oracle key at all.
      const clean = await agentToolCall({ name: 'set_text', input: { node_id: 'hero-title', text: 'Hello' }, runId: 'oracle-report' });
      expect(JSON.parse((clean.content[0] as { text: string }).text).oracle).toBeUndefined();
      flushNow();
    } finally {
      agentRunEnd({ runId: 'oracle-report' });
    }
  });

  // An EXTERNAL MCP client (Claude Code / Claude Desktop through the Revyme
  // connector) calls tools with no run_start and never sends run_end. The run
  // the tab opens for it must end on its own, or the editor stays read-only.
  it('a run opened by a bare tool call (external MCP client) releases the lock after its idle lease', async () => {
    vi.useFakeTimers();
    try {
      await agentToolCall({ name: 'get_node_tree', input: {} });
      expect(isBranchLocked(MAIN_BRANCH_ID)).toBe(true);
      // Another call inside the lease keeps it open…
      vi.advanceTimersByTime(LAZY_RUN_IDLE_MS - 1000);
      await agentToolCall({ name: 'get_node_tree', input: {} });
      vi.advanceTimersByTime(LAZY_RUN_IDLE_MS - 1000);
      expect(isBranchLocked(MAIN_BRANCH_ID)).toBe(true);
      // …and the lease counts from the LAST call.
      vi.advanceTimersByTime(2000);
      expect(isBranchLocked(MAIN_BRANCH_ID)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a run the service opened (run_start) has no lease — only run_end closes it', async () => {
    vi.useFakeTimers();
    try {
      agentRunStart({ runId: 'service-run' });
      await agentToolCall({ name: 'get_node_tree', input: {}, runId: 'service-run' });
      vi.advanceTimersByTime(LAZY_RUN_IDLE_MS * 5);
      expect(isBranchLocked(MAIN_BRANCH_ID)).toBe(true);
      agentRunEnd({ runId: 'service-run' });
      expect(isBranchLocked(MAIN_BRANCH_ID)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
