// src/ai/agent/tools/set-page-interaction.test.ts
//
// Chantier D — set_page_interaction. REAL write path end-to-end (same
// headless wiring as set-page.test.ts: resetProjectFS + real mutation queue
// with a dynamic active-path flush + seeded node cache), so the assertions
// are on the FILE — the emitted mutation is proven by reading it back:
//   - the final source contains the handler the generator writes
//     (onClick={() => setOpen(true)}) — addPageInteraction, real effect,
//   - parsePageInteractionsForNode round-trips it (the editor's own parser
//     sees the interaction),
//   - validateGeneratedCode is clean (the page would not crash at runtime),
//   - the duo ALSO lands the useState hook + React import (the interaction
//     tool ensures it) — the setter used by the handler is NOT dangling.
// Plus schema gates, the template gate, and the unknown-node error.

import { describe, it, expect, beforeEach } from 'vitest';
import { getDefaultStore } from 'jotai';
import { activeFilePathAtom } from '@/code/project/active-file-store';
import {
  initMutationQueue,
  syncQueueCode,
  getCurrentCode,
  setActiveFilePath,
  flushNow,
  validateGeneratedCode,
} from '@/code/mutation/mutation-queue';
import { resetProjectFS, projectFS, projectVersionAtom } from '@/code/project/project-fs';
import { selectedIdsAtom, seedNodesForCode } from '@/code/stores/store';
import { bumpProjectVersion } from '@/code/project/modify-file';
import { setPageVariableTool } from './set-page-variable';
import { setPageInteractionTool, INTERACTION_TRIGGER_VALUES } from './set-page-interaction';
import { ALL_TOOLS } from './index';
import {
  INTERACTION_TRIGGERS,
  attrForTrigger,
  setterName,
  parsePageInteractionsForNode,
} from '@/code/features/page-interactions';
import { getPageVariables } from '@/code/features/page-variables';

const HOME = 'app/page.client.tsx';
const TEMPLATE = 'app/LayoutClient.tsx';

// A canonical FAQ-shaped page (title click toggles an answer).
const HOME_CODE = `'use client';

/** @canvas { "viewports": [{ "id": "desktop", "label": "Desktop", "width": 1440, "isPrimary": true, "order": 0 }], "positions": { "desktop": { "x": 0, "y": 0 } } } */

import React from 'react';

export default function Page() {
  return (
    <div data-id="root" data-name="Page" style={{ position: 'relative', width: '100%', display: 'flex', flexDirection: 'column' }}>
      <p data-id="faq-title" data-name="FAQ title" style={{ position: 'relative', flex: '0 0 auto', order: '0' }}>Question</p>
      <p data-id="faq-answer" data-name="FAQ answer" style={{ position: 'relative', flex: '0 0 auto', order: '1' }}>Answer</p>
    </div>
  );
}`;

const TEMPLATE_CODE = `'use client';

import React from 'react';

export default function LayoutClient({ children }) {
  return <div data-id="root" data-name="Shell" style={{ position: 'relative', width: '100%' }}>{children}</div>;
}`;

function seedProject(): void {
  resetProjectFS(new Map<string, string>([
    [HOME, HOME_CODE],
    [TEMPLATE, TEMPLATE_CODE],
  ]));
  const store = getDefaultStore();
  store.set(selectedIdsAtom, []);
  initMutationQueue(
    projectFS.readFile(HOME) ?? '',
    (flushed) => {
      const target = store.get(activeFilePathAtom);
      projectFS.writeFile(target, flushed);
      bumpProjectVersion();
    },
  );
  store.set(activeFilePathAtom, HOME);
  setActiveFilePath(HOME);
  syncQueueCode(projectFS.readFile(HOME) ?? '');
  store.set(projectVersionAtom, (v) => v + 1);
  seedNodesForCode(projectFS.readFile(HOME) ?? '');
}

function activateTemplate(): void {
  const store = getDefaultStore();
  store.set(selectedIdsAtom, []);
  flushNow();
  store.set(activeFilePathAtom, TEMPLATE);
  setActiveFilePath(TEMPLATE);
  syncQueueCode(projectFS.readFile(TEMPLATE) ?? '');
  seedNodesForCode(projectFS.readFile(TEMPLATE) ?? '');
}

beforeEach(() => {
  seedProject();
});

const MID = { ensureCheckpoint: () => undefined, vpWidth: 1440, signal: new AbortController().signal } as never;

async function exec(
  tool: { execute: (args: Record<string, unknown>, ctx: never) => Promise<any> },
  args: Record<string, unknown>,
): Promise<{ ok: boolean; text: string }> {
  const res = await tool.execute(args, MID);
  return { ok: !res.isError, text: (res.content as any).map((c: any) => c.text).join('\n') };
}

// ─── parity: trigger enum ≡ the editor's InteractionTrigger set ─────────────

describe('set_page_interaction — trigger parity', () => {
  it('the schema enum mirrors INTERACTION_TRIGGERS exactly', () => {
    expect(INTERACTION_TRIGGER_VALUES).toEqual(INTERACTION_TRIGGERS);
    expect(INTERACTION_TRIGGER_VALUES).toEqual(['click', 'mouseEnter', 'mouseLeave']);
  });

  it('the handler string uses attrForTrigger (click → onClick, …)', () => {
    expect(attrForTrigger('click')).toBe('onClick');
    expect(attrForTrigger('mouseEnter')).toBe('onMouseEnter');
    expect(attrForTrigger('mouseLeave')).toBe('onMouseLeave');
    expect(setterName('open')).toBe('setOpen');
  });
});

// ─── THE DUO on a real projectFS — the EFFECT, not "called" ─────────────────

describe('set_page_variable + set_page_interaction — real effect on the fixture', () => {
  it('writes the annotation, the useState hook, and the onClick setter; validates clean', async () => {
    const created = await exec(setPageVariableTool, { name: 'open', type: 'boolean', value: 'false' });
    expect(created.ok).toBe(true);

    const wired = await exec(setPageInteractionTool, {
      node_id: 'faq-title',
      trigger: 'click',
      variable: 'open',
      value: 'true',
    });
    expect(wired.ok).toBe(true);
    const data = JSON.parse(wired.text);
    expect(data.handler).toBe('onClick={() => setOpen(true)}');
    expect(data.hook).toEqual('useState present');

    const finalCode = projectFS.readFile(HOME) ?? '';
    // 1. The ADD_PAGE_VARIABLE annotation.
    expect(getPageVariables(finalCode).find((v) => v.name === 'open')).toMatchObject({
      name: 'open',
      type: 'boolean',
      default: 'false',
    });
    // 2. The useState hook the interaction tool ensured (a bare "variable"
    //    without the handler would never get one — lint-warning design rule).
    expect(finalCode).toContain('const [open, setOpen] = useState(false);');
    // 3. The ADD_PAGE_INTERACTION handler on the target node.
    expect(finalCode).toContain('onClick={() => setOpen(true)}');
    // 4. React import synced (syncImports inside modifyProjectFile).
    expect(finalCode).toContain('useState');
    // 5. The queue's own base agrees (the write path is in sync).
    expect(getCurrentCode()).toContain('onClick={() => setOpen(true)}');
    // 6. The generated file passes the same validation the queue gates on.
    expect(validateGeneratedCode(finalCode)).toBeNull();
  });

  it('the interaction is round-trippable by the editor parser (real emitted mutation)', async () => {
    await exec(setPageVariableTool, { name: 'open', type: 'boolean', value: 'false' });
    await exec(setPageInteractionTool, { node_id: 'faq-title', trigger: 'click', variable: 'open', value: 'true' });
    await exec(setPageInteractionTool, { node_id: 'faq-answer', trigger: 'click', variable: 'open', value: 'false' });
    const finalCode = projectFS.readFile(HOME) ?? '';
    const parsed = parsePageInteractionsForNode(finalCode, 'faq-title');
    expect(parsed).toEqual([{ nodeId: 'faq-title', trigger: 'click', varName: 'open', value: 'true' }]);
    const onAnswer = parsePageInteractionsForNode(finalCode, 'faq-answer');
    expect(onAnswer).toEqual([{ nodeId: 'faq-answer', trigger: 'click', varName: 'open', value: 'false' }]);
    expect(finalCode).toContain('setOpen(true)');
    expect(finalCode).toContain('setOpen(false)');
    expect(validateGeneratedCode(finalCode)).toBeNull();
  });

  it('open/close pair on the same node merges into ONE block handler cleanly', async () => {
    await exec(setPageVariableTool, { name: 'open', type: 'boolean', value: 'false' });
    // Second call with the same var = UPDATE of the default, not duplicate.
    await exec(setPageVariableTool, { name: 'open', type: 'boolean', value: 'false' });
    await exec(setPageInteractionTool, { node_id: 'faq-title', trigger: 'click', variable: 'open', value: 'true' });
    const finalCode = projectFS.readFile(HOME) ?? '';
    expect((finalCode.match(/onClick=/g) ?? []).length).toBe(1);
    expect((finalCode.match(/setOpen\(/g) ?? []).length).toBe(1);
  });

  it('updating an existing variable does not duplicate the annotation entry', async () => {
    await exec(setPageVariableTool, { name: 'open', type: 'boolean', value: 'false' });
    await exec(setPageVariableTool, { name: 'open', type: 'boolean', value: 'true' });
    await exec(setPageInteractionTool, { node_id: 'faq-title', trigger: 'click', variable: 'open', value: 'true' });
    const finalCode = projectFS.readFile(HOME) ?? '';
    const vars = getPageVariables(finalCode);
    expect(vars).toHaveLength(1);
    expect(vars[0].default).toBe('true');
  });
});

// ─── failure modes ──────────────────────────────────────────────────────────

describe('set_page_interaction — clean errors', () => {
  it('fails on an unknown node_id without touching the file', async () => {
    await exec(setPageVariableTool, { name: 'open', type: 'boolean', value: 'false' });
    const before = projectFS.readFile(HOME) ?? '';
    const res = await exec(setPageInteractionTool, {
      node_id: 'ghost-node',
      trigger: 'click',
      variable: 'open',
      value: 'true',
    });
    expect(res.ok).toBe(false);
    expect(res.text).toContain('ghost-node');
    expect(projectFS.readFile(HOME)).toBe(before);
  });

  it('fails when the variable is not declared (must use set_page_variable first)', async () => {
    const res = await exec(setPageInteractionTool, {
      node_id: 'faq-title',
      trigger: 'click',
      variable: 'open',
      value: 'true',
    });
    expect(res.ok).toBe(false);
    expect(res.text).toContain('not declared');
    expect(projectFS.readFile(HOME)).toBe(HOME_CODE);
  });

  it('fails on a non-boolean value for a boolean variable', async () => {
    await exec(setPageVariableTool, { name: 'open', type: 'boolean', value: 'false' });
    const res = await exec(setPageInteractionTool, {
      node_id: 'faq-title',
      trigger: 'click',
      variable: 'open',
      value: '1',
    });
    expect(res.ok).toBe(false);
    expect(res.text).toContain("must be 'true' or 'false'");
  });

  it('refuses a mouseEnter trigger with a numeric value on a number variable (literal check)', async () => {
    await exec(setPageVariableTool, { name: 'fade', type: 'number', value: '0.5' });
    const res = await exec(setPageInteractionTool, {
      node_id: 'faq-title',
      trigger: 'mouseEnter',
      variable: 'fade',
      value: 'abc',
    });
    expect(res.ok).toBe(false);
    expect(res.text).toContain('number');
  });

  it('refuses template/layout files (Set Variable is page-only — no useState there)', async () => {
    activateTemplate();
    const res = await exec(setPageInteractionTool, {
      node_id: 'root',
      trigger: 'click',
      variable: 'open',
      value: 'true',
    });
    expect(res.ok).toBe(false);
    expect(res.text).toContain('PAGE-only');
    expect(projectFS.readFile(TEMPLATE)).toBe(TEMPLATE_CODE);
  });
});

// ─── registration ───────────────────────────────────────────────────────────

describe('set_page_interaction — registration', () => {
  it('is registered in ALL_TOOLS with the semantic category', () => {
    const tool = ALL_TOOLS.find((t) => t.name === 'set_page_interaction');
    expect(tool).toBeDefined();
    expect(tool!.category).toBe('semantic');
  });
});

// ─── P8 branched run ────────────────────────────────────────────────────────
// The hook-ensure writes through modifyProjectFile (active-map bound), so a
// branched run refuses BEFORE the queue half — never a hook-less partial
// write on the branch, never a silent main write.

describe('set_page_interaction — branched run', () => {
  it('refuses on a branch and leaves the file untouched', async () => {
    const before = projectFS.readFile(HOME) ?? '';
    const bctx = {
      ensureCheckpoint: () => undefined,
      vpWidth: 1440,
      signal: new AbortController().signal,
      workspace: { branchId: 'branch-x', filePath: HOME },
    } as never;
    const res = await setPageInteractionTool.execute(
      { node_id: 'faq-title', trigger: 'click', variable: 'open', value: 'true' },
      bctx,
    );
    expect(res.isError).toBe(true);
    const text = (res.content as any).map((c: any) => c.text).join('\n');
    expect(text).toContain('branch-x');
    expect(text).toContain('batch/chain');
    expect(projectFS.readFile(HOME)).toBe(before);
  });
});