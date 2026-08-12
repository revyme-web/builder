// border-paste.integration.test.ts — END-TO-END copy/paste of nodes whose
// border renders through the `::after` overlay rule in the page's <style>
// block. Drives the REAL pipeline (copyNodes → executePaste → mutation-queue
// flush) against an in-memory ProjectFS. Without the border carry
// (copy captureBorderOverlays → paste reinjectBorderOverlays) every pasted
// copy silently lost its border: the rule is keyed by data-id and paste mints
// new ids (user report 2026-07-29).

import { describe, it, expect, beforeEach } from 'vitest';
import { projectFS, resetProjectFS } from '@/code/project/project-fs';
import { setActiveFilePath, flushNow, initMutationQueue } from '@/code/mutation/mutation-queue';
import { setBumpVersion } from '@/code/project/modify-file';
import { parseJSXToNodes, extractStyleCSS } from '@/code/parsing/parser';
import { extractBorderAfterRuleBody } from '@/editor/ui/border-utils';
import { copyNodes, getClipboardData } from './copy';
import { executePaste } from './paste';
import { removeNodeInCode } from '@/code/generation/generator-crud';
import { parse } from '@babel/parser';

const FILE = 'app/page.tsx';

// A parent frame whose CHILD carries the ::after border — mirrors the user's
// page (dashed circle inside a timeline column). Copying the PARENT must carry
// the grandchild's rule too.
const AFTER_BODY = `content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  pointer-events: none;
  z-index: 1;
  border-width: 4px;
  border-style: dashed;
  border-color: #000000;`;

const BASE = `'use client';
import React from 'react';
export default function Page() {
  return <div data-id="root" data-name="Page" style={{ position: 'relative', width: '100%', height: 'auto' }}>
  <style>{\`
    [data-id="ring-1"]::after {
  ${AFTER_BODY}
    }
  \`}</style>
    <div data-id="wrap-1" data-name="Wrap" style={{ position: 'relative', width: '200px', height: '200px' }}>
      <div data-id="ring-1" data-name="Ring" style={{ position: 'relative', width: '65px', height: '65px', borderRadius: '107px' }}></div>
    </div>
  </div>;
}`;

const expectParses = (code: string) =>
  expect(() => parse(code, { sourceType: 'module', plugins: ['jsx', 'typescript'] })).not.toThrow();

function seed(file: string, code: string): void {
  projectFS.writeFile(file, code);
  setActiveFilePath(file);
  setBumpVersion(() => {});
  initMutationQueue(code, c => projectFS.writeFile(file, c));
}

/** The pasted copy's id: any node with the given name that isn't an original. */
function findPastedId(code: string, name: string, originalIds: Set<string>): string | undefined {
  const nodes = parseJSXToNodes(code);
  for (const n of nodes.values()) {
    if (n.name === name && !originalIds.has(n.id)) return n.id;
  }
  return undefined;
}

beforeEach(() => {
  resetProjectFS();
  localStorage.clear();
});

describe('border ::after overlay survives copy/paste', () => {
  it('copy captures the rule body for a DESCENDANT of the copied root', () => {
    seed(FILE, BASE);
    copyNodes(['wrap-1'], parseJSXToNodes(BASE));
    const clip = getClipboardData()!;
    const ring = clip.nodes.find(n => n.id === 'ring-1')!;
    expect(ring.borderAfterCSS).toContain('border-width: 4px');
    expect(ring.borderAfterCSS).toContain('border-style: dashed');
    // The un-bordered wrap carries nothing.
    expect(clip.nodes.find(n => n.id === 'wrap-1')!.borderAfterCSS).toBeUndefined();
  });

  it('same-page paste re-creates the rule under the NEW id (original untouched)', () => {
    seed(FILE, BASE);
    const nodes = parseJSXToNodes(BASE);
    copyNodes(['wrap-1'], nodes);
    executePaste({ selectedIds: ['wrap-1'], nodes, activeFilePath: FILE });
    flushNow();

    const out = projectFS.readFile(FILE)!;
    expectParses(out);
    const pastedRingId = findPastedId(out, 'Ring', new Set(['ring-1']))!;
    expect(pastedRingId).toBeDefined();
    const css = extractStyleCSS(out);
    const pastedBody = extractBorderAfterRuleBody(css, pastedRingId);
    expect(pastedBody).toContain('border-width: 4px');
    expect(pastedBody).toContain('border-style: dashed');
    expect(pastedBody).toContain('border-color: #000000');
    // Original rule still present and unchanged.
    expect(extractBorderAfterRuleBody(css, 'ring-1')).toContain('border-width: 4px');
  });

  it('cross-page paste CREATES the destination <style> block with the rule', () => {
    seed(FILE, BASE);
    copyNodes(['wrap-1'], parseJSXToNodes(BASE));

    const DEST = 'app/about/page.tsx';
    const destBase = `'use client';
import React from 'react';
export default function Page() {
  return <div data-id="root" data-name="Page" style={{ position: 'relative', width: '100%', height: 'auto' }}>
    <div data-id="hero-1" data-name="Hero" style={{ position: 'relative', width: '400px', height: '300px' }}></div>
  </div>;
}`;
    seed(DEST, destBase);
    const destNodes = parseJSXToNodes(destBase);
    executePaste({ selectedIds: ['hero-1'], nodes: destNodes, activeFilePath: DEST });
    flushNow();

    const out = projectFS.readFile(DEST)!;
    expectParses(out);
    const pastedRingId = findPastedId(out, 'Ring', new Set(['ring-1']))!;
    expect(pastedRingId).toBeDefined();
    const body = extractBorderAfterRuleBody(extractStyleCSS(out), pastedRingId);
    expect(body).toContain('border-width: 4px');
    expect(body).toContain('border-style: dashed');
  });

  it('::placeholder rule (Input tool Placeholder Color) survives copy/paste too', () => {
    // Same style-block-keyed-by-data-id failure mode as the border overlay —
    // copy captures via the pseudo-parser, paste re-injects under the new id.
    const FORM = `'use client';
import React from 'react';
export default function Page() {
  return <div data-id="root" data-name="Page" style={{ position: 'relative', width: '100%', height: 'auto' }}>
  <style>{\`
    [data-id="email-1"]::placeholder {
      color: #94a3b8 !important;
    }
  \`}</style>
    <div data-id="form-1" data-name="Form" style={{ position: 'relative', width: '400px', height: 'auto' }}>
      <input data-id="email-1" data-name="Email" type="email" placeholder="Email" style={{ position: 'relative', width: '100%' }} />
    </div>
  </div>;
}`;
    seed(FILE, FORM);
    const nodes = parseJSXToNodes(FORM);
    copyNodes(['form-1'], nodes);
    executePaste({ selectedIds: ['form-1'], nodes, activeFilePath: FILE });
    flushNow();

    const out = projectFS.readFile(FILE)!;
    expectParses(out);
    const pastedEmailId = findPastedId(out, 'Email', new Set(['email-1']))!;
    expect(pastedEmailId).toBeDefined();
    const css = extractStyleCSS(out);
    expect(css).toContain(`[data-id="${pastedEmailId}"]::placeholder`);
    // Original untouched.
    expect(css).toContain('[data-id="email-1"]::placeholder');
  });

  it('deleting the node removes its ::after rule (no orphaned CSS)', () => {
    // Delete cleanup is the other half of the lifecycle: paste re-creates
    // rules per copy, so delete must reap them — same convention as the
    // existing @media + :hover cleanup in removeNodeInCode.
    const out = removeNodeInCode(BASE, 'ring-1');
    expectParses(out);
    expect(out).not.toContain('data-id="ring-1"');
    expect(extractBorderAfterRuleBody(extractStyleCSS(out), 'ring-1')).toBeNull();
  });

  it('deleting an input removes its ::placeholder rule (no orphaned CSS)', () => {
    const FORM = `'use client';
import React from 'react';
export default function Page() {
  return <div data-id="root" data-name="Page" style={{ position: 'relative', width: '100%', height: 'auto' }}>
  <style>{\`
    [data-id="email-1"]::placeholder {
      color: #94a3b8 !important;
    }
  \`}</style>
    <input data-id="email-1" data-name="Email" type="email" style={{ position: 'relative', width: '100%' }} />
  </div>;
}`;
    const out = removeNodeInCode(FORM, 'email-1');
    expectParses(out);
    expect(out).not.toContain('data-id="email-1"');
    expect(out).not.toContain('::placeholder');
  });
});
