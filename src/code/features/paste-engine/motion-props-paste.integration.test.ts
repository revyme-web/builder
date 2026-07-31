// motion-props-paste.integration.test.ts — END-TO-END copy/paste of nodes
// carrying framer-motion tag props. Drives the REAL pipeline (parse →
// copyNodes → executePaste → mutation-queue flush) against an in-memory
// ProjectFS, exactly like overlay-paste.integration.test.ts.
//
// EMPIRICAL PIN (live find 2026-07-13): a chip with an appear width animation
// (`initial`/`whileInView`/`viewport`/`transition`) pasted WITHOUT any of
// them — the clipboard never captured `motionProps` and the AddNodeDef never
// emitted them, so the copy landed as a bare styled div with an empty
// Animation panel.

import { describe, it, expect, beforeEach } from 'vitest';
import { projectFS } from '@/code/project/project-fs';
import { setActiveFilePath, flushNow, initMutationQueue } from '@/code/mutation/mutation-queue';
import { setBumpVersion } from '@/code/project/modify-file';
import { parseJSXToNodes } from '@/code/parsing/parser';
import { copyNodes } from './copy';
import { executePaste } from './paste';
import { parse } from '@babel/parser';

const FILE = 'app/page.tsx';

const PAGE = `'use client';
import React from 'react';
import { motion } from 'framer-motion';
export default function Page() {
  return (
    <div data-id="root" style={{ position: 'relative', width: '1440px', height: '900px', display: 'flex', flexDirection: 'row', gap: '20px' }}>
      <motion.div data-id="chip" data-name="Chip" initial={{
        opacity: 0,
        y: 26,
        width: 0
      }} whileInView={{
        opacity: 1,
        y: 0,
        width: '148px'
      }} viewport={{
        once: true,
        margin: '-60px'
      }} transition={{
        type: 'spring',
        stiffness: 300,
        damping: 60,
        mass: 1,
        delay: 0.08
      }} style={{
        position: 'relative',
        flex: '0 0 auto',
        order: '0',
        width: '148px',
        height: '86px'
      }}></motion.div>
      <motion.div data-id="spinner" data-loop='{"rotate":360}' animate={{
        rotate: 360
      }} transition={{
        repeat: Infinity,
        duration: 2,
        ease: 'linear'
      }} style={{ position: 'relative', flex: '0 0 auto', order: '1', width: '40px', height: '40px' }}></motion.div>
    </div>
  );
}`;

function seed(code: string): void {
  projectFS.writeFile(FILE, code);
  setActiveFilePath(FILE);
  setBumpVersion(() => {});
  initMutationQueue(code, c => projectFS.writeFile(FILE, c));
}

/** Every opening tag containing `marker`, scanned to its real close
 *  (skipping `{{ … }}` expressions). */
function openingTags(code: string, marker: string): string[] {
  const tags: string[] = [];
  let from = 0;
  while (true) {
    const at = code.indexOf(marker, from);
    if (at === -1) break;
    const tagStart = code.lastIndexOf('<', at);
    let depth = 0;
    for (let i = tagStart; i < code.length; i++) {
      if (code[i] === '{') depth++;
      else if (code[i] === '}') depth--;
      else if (code[i] === '>' && depth === 0) { tags.push(code.slice(tagStart, i + 1)); break; }
    }
    from = at + marker.length;
  }
  return tags;
}

/** The pasted copy's opening tag: carries `marker` but NOT the source id
 *  (pasted ids are minted from the node type — `div-…` — so the marker
 *  attribute is what identifies the copy). */
function pastedOpeningTag(code: string, marker: string, sourceId: string): string {
  const tag = openingTags(code, marker).find(t => !t.includes(`data-id="${sourceId}"`));
  expect(tag, `no pasted copy carrying ${marker}`).toBeTruthy();
  return tag!;
}

const expectParses = (code: string) =>
  expect(() => parse(code, { sourceType: 'module', plugins: ['jsx', 'typescript'] })).not.toThrow();

describe('motion props copy/paste — end-to-end', () => {
  beforeEach(() => seed(PAGE));

  it('appear (initial/whileInView/viewport/transition) survives sibling paste', () => {
    const nodes = parseJSXToNodes(PAGE);
    copyNodes(['chip'], nodes);
    const result = executePaste({ selectedIds: ['chip'], nodes, activeFilePath: FILE });
    expect(result.success).toBe(true);
    flushNow();

    const out = projectFS.readFile(FILE)!;
    expectParses(out);
    const tag = pastedOpeningTag(out, 'data-name="Chip"', 'chip');

    // All four motion props landed on the pasted tag with their values.
    expect(tag).toContain('initial={{');
    expect(tag).toMatch(/initial=\{\{[^}]*y: 26/);
    expect(tag).toMatch(/whileInView=\{\{[^}]*width: '148px'/);
    expect(tag).toMatch(/viewport=\{\{[^}]*once: true/);
    expect(tag).toMatch(/viewport=\{\{[^}]*margin: '-60px'/);
    expect(tag).toMatch(/transition=\{\{[^}]*stiffness: 300/);
    expect(tag).toMatch(/transition=\{\{[^}]*type: 'spring'/);

    // Source node untouched (still exactly one chip with the original id).
    expect(out.match(/data-id="chip"/g)!.length).toBe(1);
  });

  it('appear survives paste of the PARENT frame (descendant motion props ride along)', () => {
    const nodes = parseJSXToNodes(PAGE);
    copyNodes(['root'], nodes);
    const result = executePaste({
      selectedIds: [], nodes,
      forcePosition: { x: 200, y: 1200 },
      viewportWidths: { desktop: 1440 },
      activeFilePath: FILE,
    });
    expect(result.success).toBe(true);
    flushNow();

    const out = projectFS.readFile(FILE)!;
    expectParses(out);
    const tag = pastedOpeningTag(out, 'data-name="Chip"', 'chip');
    expect(tag).toMatch(/whileInView=\{\{[^}]*width: '148px'/);
    expect(tag).toMatch(/viewport=\{\{[^}]*once: true/);
  });

  it('declarative loop (animate + repeat: Infinity) survives paste', () => {
    const nodes = parseJSXToNodes(PAGE);
    copyNodes(['spinner'], nodes);
    executePaste({ selectedIds: ['spinner'], nodes, activeFilePath: FILE });
    flushNow();

    const out = projectFS.readFile(FILE)!;
    expectParses(out);
    const tag = pastedOpeningTag(out, 'data-loop', 'spinner');
    expect(tag).toMatch(/animate=\{\{[^}]*rotate: 360/);
    expect(tag).toMatch(/transition=\{\{[^}]*repeat: Infinity/);   // unquoted
    expect(tag).toMatch(/transition=\{\{[^}]*ease: 'linear'/);
    expect(tag).toContain('data-loop');
  });

  it('plain node without motion props pastes without gaining any', () => {
    const PLAIN = `'use client';
import React from 'react';
export default function Page() {
  return (
    <div data-id="root" style={{ position: 'relative', display: 'flex' }}>
      <div data-id="box" data-name="Box" style={{ position: 'relative', flex: '0 0 auto', width: '100px', height: '100px' }}></div>
    </div>
  );
}`;
    seed(PLAIN);
    const nodes = parseJSXToNodes(PLAIN);
    copyNodes(['box'], nodes);
    executePaste({ selectedIds: ['box'], nodes, activeFilePath: FILE });
    flushNow();

    const out = projectFS.readFile(FILE)!;
    expectParses(out);
    const tag = pastedOpeningTag(out, 'data-name="Box"', 'box');
    expect(tag).not.toContain('whileInView');
    expect(tag).not.toContain('initial=');
  });
});
