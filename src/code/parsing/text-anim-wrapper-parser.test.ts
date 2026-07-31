// text-anim-wrapper-parser.test.ts — the parser must see THROUGH <RevymeSplitText>.
//
// Text effects wrap their content in a runtime component. The wrapper must never become a
// canvas node (it would get an auto_N id, break shouldUseInnerHTML's childrenCount===0 check,
// and show a junk row in the layers panel), and every text detector must resolve one level
// deeper — otherwise a CMS binding, text variable or translation key goes dark the moment an
// effect is applied.

import { describe, it, expect } from 'vitest';
import { parseJSXToNodes } from './parser';
import type { SplitTextSpec } from '@revyme/runtime';
import type { TextAnimConfig } from '@/editor/tools/AnimationTool/motion/text-anim-presets';

const SPEC = `data-text-anim='{"animationType":"character","opacity":0}'`;
const wrap = (body: string) => `<RevymeSplitText spec={{ animationType: "character", opacity: 0 }}>${body}</RevymeSplitText>`;

function nodeOf(page: string, id: string) {
  return parseJSXToNodes(page).get(id);
}

const inMap = (body: string) => `import React from 'react';
import { motion } from 'framer-motion';
import { RevymeSplitText } from '@revyme/runtime';
import projects from '@/cms/projects.json';
export default function Page() {
  return <div data-id="root">{projects.map((item, idx) => (
    <div data-id="row" key={idx}><p data-id="title" ${SPEC}>${body}</p></div>
  ))}</div>;
}`;

describe('parser sees through the wrapper', () => {
  it('detects a CMS binding inside the wrapper', () => {
    const n = nodeOf(inMap(wrap('{item.title}')), 'title');
    expect(n?.binding).toEqual({ field: 'title', property: 'text' });
  });

  it('the wrapper never becomes a node', () => {
    const nodes = parseJSXToNodes(inMap(wrap('{item.title}')));
    expect([...nodes.keys()].filter((k) => k.startsWith('auto_'))).toEqual([]);
    expect(nodes.get('title')?.children ?? []).toHaveLength(0);
  });

  it('detects a translation key inside the wrapper', () => {
    const page = `import React from 'react';
import { RevymeSplitText } from '@revyme/runtime';
export default function Page() {
  const t = (k) => k;
  return <div data-id="root"><p data-id="title" ${SPEC}>${wrap("{t('hero')}")}</p></div>;
}`;
    expect(nodeOf(page, 'title')?.translationKey).toBe('hero');
  });

  it('plain text inside the wrapper becomes real textContent', () => {
    const page = `import React from 'react';
import { RevymeSplitText } from '@revyme/runtime';
export default function Page() {
  return <div data-id="root"><p data-id="title" ${SPEC}>${wrap('Hello World')}</p></div>;
}`;
    expect(nodeOf(page, 'title')?.textContent).toContain('Hello World');
  });

  it('a wrapped node parked in canvasNodes also resolves (second walker)', () => {
    const page = `import React from 'react';
import { RevymeSplitText } from '@revyme/runtime';
export default function Page() { return <div data-id="root"></div>; }

const canvasNodes = (<>
  <p data-id="title" data-canvas-node="true" ${SPEC}>${wrap('Hello World')}</p>
</>);`;
    const nodes = parseJSXToNodes(page);
    expect(nodes.get('title')?.textContent).toContain('Hello World');
    expect([...nodes.keys()].filter((k) => k.startsWith('auto_'))).toEqual([]);
  });
});

describe('spec type parity with the builder config', () => {
  // A field added to TextAnimConfig without a runtime counterpart fails here rather than
  // silently doing nothing on the published site.
  it('TextAnimConfig is assignable to SplitTextSpec', () => {
    const cfg: TextAnimConfig = { animationType: 'character', mask: true, opacity: 0, y: '100%', delay: 0.05 };
    const spec: SplitTextSpec = cfg;
    expect(spec.animationType).toBe('character');
  });
});
