// src/ai/agent/tools/set-page-variable.test.ts
//
// Chantier D — set_page_variable primitives. Zero LLM, zero BENCH_RUN.
// PART 1 (mocked queue): the exact mutations the tool queues
// (addPageVariable / updatePageVariable payloads, the PageVariablesModal's
// dialect) + schema gates (camelCase names, type enum, boolean/number
// default coercion).
// PART 2 (real FS): v_couple lives in set-page-interaction.test.ts — this
// file only asserts the declaration side against a real projectFS.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { atom } from 'jotai';
import { z } from 'zod';
import type { AgentTool, ToolContext } from '@/ai/agent';
import {
  setPageVariableTool,
  ensurePageVariableHookInCode,
  PAGE_VARIABLE_TYPES,
} from './set-page-variable';
import { ALL_TOOLS } from './index';

vi.mock('@/code/mutation/mutation-queue', () => ({
  queueMutation: vi.fn(),
  flushNow: vi.fn(),
  // P8: the tool routes through workspace.ts, which resolves the queue's
  // active file for unbranched runs — same mocked module, one more key.
  getQueueActiveFilePath: vi.fn(() => 'app/page.client.tsx'),
}));

vi.mock('@/code/project/project-fs', () => ({
  // P8: workspace.ts resolves the run's branch on every routed read/write —
  // unbranched tests stay on 'main'; readBranchFile only serves branched runs.
  projectFS: {
    readFile: vi.fn(() => null),
    writeFile: vi.fn(),
    getActiveBranchId: () => 'main',
    readBranchFile: vi.fn(() => null),
  },
}));

vi.mock('@/code/project/active-file-store', () => ({
  activeFilePathAtom: atom<string>('app/page.client.tsx'),
}));

import { queueMutation, flushNow } from '@/code/mutation/mutation-queue';

function makeCtx(): ToolContext {
  return { ensureCheckpoint: vi.fn(), vpWidth: 1440, signal: new AbortController().signal };
}

function schemaOf(tool: AgentTool) {
  return z.object(tool.inputSchema);
}

function parseInput(tool: AgentTool, input: Record<string, unknown>) {
  return schemaOf(tool).safeParse(input);
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── schema gates ───────────────────────────────────────────────────────────

describe('set_page_variable — schema', () => {
  it('rejects a non-camelCase name', () => {
    const r = parseInput(setPageVariableTool, { name: 'Open State', type: 'boolean', value: 'false' });
    expect(r.success).toBe(false);
    const r2 = parseInput(setPageVariableTool, { name: 'openState1', type: 'boolean', value: 'false' });
    expect(r2.success).toBe(true);
  });

  it('accepts exactly the PageVariableType primitives', () => {
    expect(PAGE_VARIABLE_TYPES).toEqual(['number', 'text', 'boolean', 'color', 'image', 'componentCursor']);
    for (const type of PAGE_VARIABLE_TYPES) {
      expect(parseInput(setPageVariableTool, { name: 'x', type, value: '1' }).success).toBe(true);
    }
    expect(parseInput(setPageVariableTool, { name: 'x', type: 'string', value: '1' }).success).toBe(false);
    expect(parseInput(setPageVariableTool, { name: 'x', type: 42, value: '1' }).success).toBe(false);
  });
});

// ─── mutation payloads (mock the queue, like action-layer.test.ts) ──────────

describe('set_page_variable — payloads', () => {
  it('queues addPageVariable with a typed default when value is omitted (boolean)', async () => {
    const res = await setPageVariableTool.execute({ name: 'open', type: 'boolean' }, makeCtx());
    expect(res.isError).not.toBe(true);
    expect(queueMutation).toHaveBeenCalledWith({
      type: 'addPageVariable',
      variable: { name: 'open', type: 'boolean', default: 'false' },
    }, expect.anything());
    expect(flushNow).toHaveBeenCalled();
    const data = JSON.parse((res.content[0] as any).text);
    expect(data.action).toBe('created');
    expect(data.variable).toBe('open');
  });

  it('passes the string default through verbatim (number/color/text dialect)', async () => {
    await setPageVariableTool.execute({ name: 'fade', type: 'number', value: '0.5' }, makeCtx());
    expect(queueMutation).toHaveBeenCalledWith({
      type: 'addPageVariable',
      variable: { name: 'fade', type: 'number', default: '0.5' },
    }, expect.anything());
    await setPageVariableTool.execute({ name: 'brand', type: 'color', value: '#6366f1' }, makeCtx());
    expect(queueMutation).toHaveBeenCalledWith({
      type: 'addPageVariable',
      variable: { name: 'brand', type: 'color', default: '#6366f1' },
    }, expect.anything());
  });

  it('rejects a non-boolean default for a boolean variable (would silently coerce to false)', async () => {
    const res = await setPageVariableTool.execute({ name: 'open', type: 'boolean', value: '1' }, makeCtx());
    expect(res.isError).toBe(true);
    expect(queueMutation).not.toHaveBeenCalled();
  });

  it('rejects a non-numeric default for a number variable', async () => {
    const res = await setPageVariableTool.execute({ name: 'fade', type: 'number', value: 'abc' }, makeCtx());
    expect(res.isError).toBe(true);
    expect(queueMutation).not.toHaveBeenCalled();
  });

  it('queues updatePageVariable when the variable already exists (modal save contract)', async () => {
    vi.mocked(projectFS.readFile).mockReturnValue(
      `'use client';
/** @pageVariables {
  "variables": [
    { "name": "open", "type": "boolean", "default": "false" }
  ]
} */
export default function Page() { return <div data-id="root" style={{}} />; }`,
    );
    const res = await setPageVariableTool.execute(
      { name: 'open', type: 'boolean', value: 'true', description: 'FAQ state' },
      makeCtx(),
    );
    expect(res.isError).not.toBe(true);
    expect(queueMutation).toHaveBeenCalledWith({
      type: 'updatePageVariable',
      oldName: 'open',
      updates: { default: 'true', description: 'FAQ state' },
    }, expect.anything());
    expect(queueMutation).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'addPageVariable' }));
  });
});

// ─── ensurePageVariableHookInCode (pure generator, shared with the duo) ─────

const PAGE_WITH_VAR = `'use client';

/** @pageVariables {
  "variables": [
    { "name": "open", "type": "boolean", "default": "false" }
  ]
} */

import React from 'react';

export default function Page() {
  return (
    <div data-id="root" data-name="Page" style={{ position: 'relative', width: '100%', display: 'flex', flexDirection: 'column' }}>
      <p data-id="faq-title" data-name="FAQ title" style={{ position: 'relative', flex: '0 0 auto' }}>Question</p>
    </div>
  );
}`;

describe('ensurePageVariableHookInCode', () => {
  it('inserts the useState pair at the top of the page function, typed default', () => {
    const out = ensurePageVariableHookInCode(PAGE_WITH_VAR, 'open');
    expect(out).toContain('const [open, setOpen] = useState(false);');
    expect(out.match(/useState\(/g)).toHaveLength(1); // not doubled
    const again = ensurePageVariableHookInCode(out, 'open');
    expect(again).toBe(out);
  });

  it('uses the numeric/string literal for non-boolean types', () => {
    const code = PAGE_WITH_VAR.replace(
      /"type": "boolean"/, '"type": "number"',
    ).replace(/^(\s*)\{ "name": "open", "type": "number", "default": "false" \}/m, '$1{ "name": "open", "type": "number", "default": "0.5" }');
    const out = ensurePageVariableHookInCode(code, 'open');
    expect(out).toContain('const [open, setOpen] = useState(0.5);');
  });

  it('is a no-op when the variable is not declared in the annotation', () => {
    const out = ensurePageVariableHookInCode(PAGE_WITH_VAR, 'undeclared');
    expect(out).toBe(PAGE_WITH_VAR);
  });

  it('is a no-op when the variable is a function param (template/component)', () => {
    const code = `export default function Page({ open = false }) {
  return <div data-id="root" style={{}} />;
}`;
    const out = ensurePageVariableHookInCode(code, 'open');
    expect(out).toBe(code);
  });

  it('handles the withResponsiveProps export shape', () => {
    const code = `'use client';

/** @pageVariables {
  "variables": [
    { "name": "open", "type": "boolean", "default": "false" }
  ]
} */

import React from 'react';
import { withResponsiveProps } from '@revyme/runtime';

function Page() {
  return (
    <div data-id="root" data-name="Page" style={{ position: 'relative', width: '100%', display: 'flex', flexDirection: 'column' }}>
      <p data-id="faq-title" data-name="FAQ title" style={{ position: 'relative', flex: '0 0 auto' }}>Question</p>
    </div>
  );
}
export default withResponsiveProps(Page);`;
    const out = ensurePageVariableHookInCode(code, 'open');
    expect(out).toContain('const [open, setOpen] = useState(false);');
  });
});

// ─── registration ───────────────────────────────────────────────────────────

describe('set_page_variable — registration', () => {
  it('is registered in ALL_TOOLS with the semantic category', () => {
    const tool = ALL_TOOLS.find((t) => t.name === 'set_page_variable');
    expect(tool).toBeDefined();
    expect(tool!.category).toBe('semantic');
  });
});

// re-import for the mocked projectFS used above
import { projectFS } from '@/code/project/project-fs';

// ─── P8 branched routing ────────────────────────────────────────────────────
// The queue write carries the branch envelope and the flush is scoped; the
// working-file read resolves through the bound workspace file.

describe('set_page_variable — branched run', () => {
  it('routes the mutation through the branch envelope (scoped flush)', async () => {
    const bctx: ToolContext = {
      ...makeCtx(),
      workspace: { branchId: 'branch-x', filePath: 'app/page.client.tsx' },
    };
    const res = await setPageVariableTool.execute({ name: 'open', type: 'boolean' }, bctx);
    expect(res.isError).not.toBe(true);
    expect(queueMutation).toHaveBeenCalledWith(
      { type: 'addPageVariable', variable: { name: 'open', type: 'boolean', default: 'false' } },
      { author: 'agent', file: 'app/page.client.tsx', branchId: 'branch-x' },
    );
    expect(flushNow).toHaveBeenCalledWith({ branchId: 'branch-x' });
  });
});