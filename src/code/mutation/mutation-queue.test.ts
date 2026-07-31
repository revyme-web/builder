import { describe, test, expect, beforeEach } from 'vitest';
import { initMutationQueue, queueMutation, queueMutations, syncQueueCode, flushNow, getCurrentCode, syncImports } from './mutation-queue';
import { parseJSXToNodes } from '../parsing/parser';

const SIMPLE_CODE = `<div data-id="root" style={{position: 'relative', width: '1440px'}}>
  <div data-id="box" style={{position: 'absolute', left: '10px', top: '20px', width: '100px'}}></div>
</div>`;

describe('mutation-queue', () => {
  let lastFlushedCode: string;

  beforeEach(() => {
    lastFlushedCode = '';
    initMutationQueue(
      SIMPLE_CODE,
      (code) => { lastFlushedCode = code; },
      () => {},
      () => {},
    );
  });

  test('queueMutation + flushNow applies style change', () => {
    queueMutation({ type: 'updateStyles', nodeId: 'box', styles: { left: '50px' } });
    flushNow();

    expect(lastFlushedCode).toContain("left: '50px'");
  });

  test('queueMutations + flushNow batches multiple mutations', () => {
    queueMutations([
      { type: 'updateStyles', nodeId: 'box', styles: { left: '50px' } },
      { type: 'updateStyles', nodeId: 'box', styles: { top: '100px' } },
    ]);
    flushNow();

    expect(lastFlushedCode).toContain("left: '50px'");
    expect(lastFlushedCode).toContain("top: '100px'");
  });

  test('getCurrentCode reflects applied mutations', () => {
    queueMutation({ type: 'updateStyles', nodeId: 'box', styles: { left: '99px' } });
    flushNow();

    expect(getCurrentCode()).toContain("left: '99px'");
  });

  test('syncQueueCode updates internal code reference', () => {
    const newCode = `<div data-id="new" style={{width: '800px'}}></div>`;
    syncQueueCode(newCode);
    expect(getCurrentCode()).toBe(newCode);
  });

  test('mutation preserves unrelated nodes', () => {
    queueMutation({ type: 'updateStyles', nodeId: 'box', styles: { left: '50px' } });
    flushNow();

    const nodes = parseJSXToNodes(lastFlushedCode);
    // root preserved
    expect(nodes.get('root')!.styles.position).toBe('relative');
    expect(nodes.get('root')!.styles.width).toBe('1440px');
    // box: changed property
    expect(nodes.get('box')!.styles.left).toBe('50px');
    // box: unchanged properties preserved
    expect(nodes.get('box')!.styles.top).toBe('20px');
    expect(nodes.get('box')!.styles.width).toBe('100px');
  });

  test('flushNow with empty queue does nothing', () => {
    lastFlushedCode = '';
    flushNow();
    expect(lastFlushedCode).toBe('');
  });

  test('multiple sequential flushes work correctly', () => {
    queueMutation({ type: 'updateStyles', nodeId: 'box', styles: { left: '50px' } });
    flushNow();
    expect(lastFlushedCode).toContain("left: '50px'");

    queueMutation({ type: 'updateStyles', nodeId: 'box', styles: { top: '100px' } });
    flushNow();
    expect(lastFlushedCode).toContain("left: '50px'"); // previous change preserved
    expect(lastFlushedCode).toContain("top: '100px'");  // new change applied
  });
});

// ─── move auto-disconnects slot-hoisted canvas nodes ───────────────────────
//
// Regression: dragging a slot-connected canvas node onto a regular frame
// looked broken. The node lives as `const cn_<id> = <jsx/>` referenced via
// `{cn_<id>}` inside the slot-bearing component (e.g. <Marquee>). On reparent
// `moveNodeInCode` walks JSX for the node's current location, finds it
// only inside a hoisted const (not inside any visible parent), and the
// move either no-ops or produces broken output. The slot wiring also
// sticks around after the visual move.
//
// Fix: the 'move' case runs a `disconnectSlotInCode` pre-pass for every
// component referencing the moved node (mutation-queue.ts). After the
// last disconnect the node is inlined back into `canvasNodes`, so the
// regular move applies to a now-inline canvas node — same path as any
// other free-floating node.
describe('hoistInstanceProp — queue dispatch round-trip', () => {
  test('queueMutation + flushNow hoists a nested-instance prop end-to-end', () => {
    const HOIST_SOURCE = `import React from 'react';
import Card from '@/components/Card';

function Parent({ style }) {
  return (
    <div data-id="root">
      <Card data-id="card-1" bg="#ff0000" />
    </div>
  );
}
export default Parent;`;

    let lastCode = '';
    initMutationQueue(
      HOIST_SOURCE,
      (c) => { lastCode = c; },
      () => {},
      () => {},
    );
    queueMutation({
      type: 'hoistInstanceProp',
      instanceNodeId: 'card-1',
      componentName: 'Card',
      propName: 'bg',
      variable: { name: 'primaryColor', type: 'color', default: '#ff0000' },
    });
    flushNow();

    // JSX rewritten
    expect(lastCode).toContain('bg={primaryColor}');
    expect(lastCode).not.toMatch(/bg="#ff0000"/);
    // Function signature destructure has the new prop
    expect(lastCode).toMatch(/primaryColor\s*=\s*['"]#ff0000['"]/);
    // @pageVariables annotation present
    expect(lastCode).toContain('@pageVariables');
    expect(lastCode).toContain('"name": "primaryColor"');
  });
});

describe('move auto-disconnects slot-hoisted canvas nodes', () => {
  const SLOTTED_CODE = `function Page() {
  return (
    <div data-id="root">
      <div data-id="white-frame" style={{ position: 'absolute', width: '600px', height: '400px' }}>
        <Marquee data-id="marquee-1" data-name="Marquee">{cn_dark_box}</Marquee>
      </div>
    </div>
  );
}

const cn_dark_box = <div data-id="dark-box" data-canvas-node="true" style={{ position: 'absolute', width: '80px', height: '80px', left: '-260px', top: '-20px', backgroundColor: '#311' }}></div>;
`;

  test('move into a frame auto-disconnects, then reparents', () => {
    let flushed = '';
    initMutationQueue(SLOTTED_CODE, (code) => { flushed = code; }, () => {}, () => {});

    queueMutation({
      type: 'move',
      nodeId: 'dark-box',
      newParentId: 'white-frame',
      styles: { position: 'absolute', left: '40px', top: '40px' },
    });
    flushNow();

    // No more slot hoist (const cn_dark_box removed).
    expect(flushed).not.toContain('const cn_dark_box');
    // No more {cn_dark_box} reference inside the Marquee.
    expect(flushed).not.toContain('{cn_dark_box}');
    // The node is now a real child of white-frame at the entry coords.
    const nodes = parseJSXToNodes(flushed);
    const dark = nodes.get('dark-box');
    expect(dark).toBeDefined();
    expect(dark!.parentId).toBe('white-frame');
    expect(dark!.styles.left).toBe('40px');
    expect(dark!.styles.top).toBe('40px');
  });

  test('move to null (unparent to canvas) also auto-disconnects', () => {
    let flushed = '';
    initMutationQueue(SLOTTED_CODE, (code) => { flushed = code; }, () => {}, () => {});

    queueMutation({
      type: 'move',
      nodeId: 'dark-box',
      newParentId: null,
      canvasNode: true,
      styles: { position: 'absolute', left: '50px', top: '60px' },
    });
    flushNow();

    expect(flushed).not.toContain('const cn_dark_box');
    expect(flushed).not.toContain('{cn_dark_box}');
    // Still a canvas node (free-floating) at the new coords.
    const nodes = parseJSXToNodes(flushed);
    const dark = nodes.get('dark-box');
    expect(dark).toBeDefined();
    expect(dark!.isCanvasNode).toBe(true);
    expect(dark!.parentId).toBeNull();
    expect(dark!.styles.left).toBe('50px');
    expect(dark!.styles.top).toBe('60px');
  });

  test('move of a node not connected to any slot is unaffected', () => {
    let flushed = '';
    initMutationQueue(SIMPLE_CODE, (code) => { flushed = code; }, () => {}, () => {});

    queueMutation({
      type: 'move',
      nodeId: 'box',
      newParentId: null,
      canvasNode: true,
      styles: { left: '999px', top: '999px' },
    });
    flushNow();

    // Sanity: regular move path still works for non-slot nodes.
    expect(flushed).toContain("left: '999px'");
  });
});

// ─── syncImports preservation ──────────────────────────────────────────────
//
// Regression: syncImports used to rebuild the import block from scratch and
// only kept lines starting with `import `. /** @canvas { ... } */ and
// /** @pageVariables { ... } */ JSDoc blocks at the top of the file were
// captured into the "import region" but never re-emitted, so a useState
// insert that triggered an import sync would silently strip the page-variable
// declaration block. These tests pin the fix in place.

describe('syncImports — top-of-file JSDoc block preservation', () => {
  test('preserves /** @pageVariables */ block', () => {
    const code = `'use client';

/** @pageVariables {
  "variables": [
    { "name": "fade", "type": "number", "default": "1" }
  ]
} */
import React, { useState } from 'react';

export default function Page() {
  const [fade, setFade] = useState(1);
  return <div style={{ opacity: fade }} />;
}`;
    const out = syncImports(code);
    expect(out).toContain('@pageVariables');
    expect(out).toContain('"name": "fade"');
    expect(out).toContain("import React");
  });

  test('preserves /** @canvas */ block', () => {
    const code = `'use client';

/** @canvas {
  "viewports": [{ "id": "desktop", "label": "Desktop", "width": 1440 }],
  "positions": {}
} */
import React from 'react';

export default function Page() {
  return <div />;
}`;
    const out = syncImports(code);
    expect(out).toContain('@canvas');
    expect(out).toContain('"viewports"');
  });

  test('preserves BOTH @canvas and @pageVariables', () => {
    const code = `'use client';

/** @canvas { "viewports": [], "positions": {} } */
/** @pageVariables { "variables": [{"name":"fade","type":"number","default":"1"}] } */
import React, { useState } from 'react';

export default function Page() {
  const [fade, setFade] = useState(1);
  return <div style={{ opacity: fade }} />;
}`;
    const out = syncImports(code);
    expect(out).toContain('@canvas');
    expect(out).toContain('@pageVariables');
  });

  test('block survives a useState-triggering re-sync (the actual bug)', () => {
    // The user-reported scenario: fresh code already has @pageVariables
    // (from addPageVariableInCode) and a useState reference (from
    // syncPageVariableHooks). syncImports is then triggered because
    // bindStylePageVariable is in importAffectingTypes — it must NOT
    // strip the annotation while adjusting the React import.
    const code = `'use client';

/** @pageVariables {
  "variables": [
    { "name": "fdfdfdfd", "type": "number", "default": "1" }
  ]
} */
import React from 'react';

export default function Page() {const [fdfdfdfd, setFdfdfdfd] = useState(1);
  return <div style={{ opacity: fdfdfdfd }} />;
}`;
    const out = syncImports(code);
    // Annotation present → modal can find the variable.
    expect(out).toContain('@pageVariables');
    expect(out).toContain('"name": "fdfdfdfd"');
    // useState added to React import — matches the body usage.
    expect(out).toMatch(/import React,\s*\{[^}]*useState[^}]*\}\s+from\s+['"]react['"]/);
  });

  describe('move coalescing (boundary-crossing drag)', () => {
    let flushed = '';
    const MULTI = `<div data-id="root" style={{position: 'relative'}}>
  <div data-id="chip" style={{position: 'absolute'}}></div>
  <div data-id="a" data-name="A"></div>
  <div data-id="b" data-name="B"></div>
  <div data-id="c" data-name="C"></div>
</div>`;

    test('three queued moves of one node collapse to the LAST parent only', () => {
      initMutationQueue(MULTI, (code) => { flushed = code; }, () => {}, () => {});
      // Simulate a drag that crossed boundaries: chip → a → b → c.
      queueMutation({ type: 'move', nodeId: 'chip', newParentId: 'a', canvasNode: false });
      queueMutation({ type: 'move', nodeId: 'chip', newParentId: 'b', canvasNode: false });
      queueMutation({ type: 'move', nodeId: 'chip', newParentId: 'c', canvasNode: false });
      flushNow();

      const nodes = parseJSXToNodes(flushed);
      // Final home only — intermediates superseded.
      expect(nodes.get('chip')?.parentId).toBe('c');
      expect(nodes.get('a')?.children ?? []).not.toContain('chip');
      expect(nodes.get('b')?.children ?? []).not.toContain('chip');
      expect(nodes.get('c')?.children ?? []).toContain('chip');
      // The chip appears exactly once (no duplicate from re-applying moves).
      expect((flushed.match(/data-id="chip"/g) ?? []).length).toBe(1);
    });

    test('moves of DIFFERENT nodes are all kept', () => {
      initMutationQueue(MULTI, (code) => { flushed = code; }, () => {}, () => {});
      queueMutation({ type: 'move', nodeId: 'chip', newParentId: 'a', canvasNode: false });
      queueMutation({ type: 'move', nodeId: 'b', newParentId: 'c', canvasNode: false });
      flushNow();

      const nodes = parseJSXToNodes(flushed);
      expect(nodes.get('chip')?.parentId).toBe('a');
      expect(nodes.get('b')?.parentId).toBe('c');
    });
  });
});

// ─── flushNow syntax gate ───────────────────────────────────────────────────
// `processQueue` has always validated + rolled back, but `flushNow` — the path
// every creator and the overlay tool take to get their node into the parse the
// same tick — committed whatever the generator produced. A generator bug there
// wrote a broken file instead of failing the action: the parse yielded zero
// nodes and the page went blank with no way back (live find 2026-07-25, an
// overlay `useState` spliced inside the root element's `style={{ }}`).

const PAGE_WITH_OVERLAY = `'use client';
import React, { useState, useLayoutEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
export default function Page() {
  const [aOpen, setAOpen] = useState(false);
  useLayoutEffect(() => {
    if (!aOpen) return;
    const position = () => {
      const o = document.querySelector('[data-id="a"]');
      if (!o) return;
      const raw = JSON.parse(o.getAttribute('data-overlay') || '{}');
      o.style.top = raw.offsetY + 'px';
    };
    position();
    return () => { window.removeEventListener('resize', position); };
  }, [aOpen]);  return <div data-id="root" style={{
    display: 'flex',
    width: '100%'
  }}>
    <div data-id="hero" data-overlay-trigger='{"targetId":"a","trigger":"click","dismiss":"outside"}' onClick={() => setAOpen(!aOpen)}>Hero</div>
    <div data-id="btn">FIX OVERLAYS</div>
    <AnimatePresence>{aOpen && (
      <motion.div key="a" data-id="a" data-overlay='{"type":"relative","triggerId":"hero","side":"bottom","align":"start","offsetX":0,"offsetY":0}' style={{ position: 'fixed' }}></motion.div>
    )}</AnimatePresence>
  </div>;
}
`;

describe('flushNow — a second overlay on a page that already has one', () => {
  test('commits code the parser can still read (page does not go blank)', () => {
    initMutationQueue(PAGE_WITH_OVERLAY, () => {});
    queueMutation({
      type: 'createOverlay',
      triggerId: 'btn',
      overlayId: 'b',
      overlayConfig: { type: 'relative', triggerId: 'btn', side: 'bottom', align: 'center', offsetX: 0, offsetY: 10 },
      triggerConfig: { targetId: 'b', trigger: 'click', dismiss: 'outside' },
    } as never);
    flushNow();

    const out = getCurrentCode();
    const nodes = parseJSXToNodes(out);
    // The corruption produced ZERO nodes — the blank canvas.
    expect(nodes.size).toBeGreaterThan(1);
    expect(nodes.has('root')).toBe(true);
    expect(nodes.has('b')).toBe(true);
    expect(nodes.has('a')).toBe(true); // the pre-existing overlay survives
    // The new state landed in the body, never inside the root's style object.
    expect(out.indexOf('const [bOpen, setBOpen] = useState(false)'))
      .toBeLessThan(out.indexOf('<div data-id="root"'));
  });
});

// ─── exit-to-canvas: parent-flow props die with the parent ──────────────────
//
// Reported (2026-07-26): dragging a node out of a flex row onto the canvas kept
// `flex: '1 0 0px'` in the emitted `canvasNodes` fragment — a grow factor with
// no flex parent to grow inside. Every exit path builds its commit styles from
// position/size only (the strategies clear flex on the mid-drag LIFT styles, the
// `zIndex: 9999` overlay, never on the commit), and there are four
// `canvasNode: true` call sites — so the normalisation lives on the ONE mutation
// they all funnel through.

import { injectNodeIntoCache, removeNodeFromCache } from '../stores/store';
import type { CanvasNode } from '../parsing/parser';

const FLEX_ROW_CODE = `<div data-id="root" style={{display: 'flex', flexDirection: 'row'}}>
  <div data-id="aura" style={{flex: '1 0 0px', width: '360px', height: '503px', order: '1', alignSelf: 'center'}}></div>
  <div data-id="sib" style={{flex: '1 0 0px'}}></div>
  <div data-id="plain" style={{width: '100px', height: '100px'}}></div>
</div>`;

function cacheNode(id: string, styles: Record<string, string>) {
  injectNodeIntoCache({
    id, type: 'div', parentId: 'root', children: [], styles, attrs: {},
    textContent: '', order: 0,
  } as unknown as CanvasNode);
}

describe('exit-to-canvas flow-prop reset', () => {
  let flushed: string;

  beforeEach(() => {
    flushed = '';
    initMutationQueue(FLEX_ROW_CODE, (code) => { flushed = code; }, () => {}, () => {});
  });

  test('rewrites flex 1 0 0px → 0 0 auto and drops order/align-self', () => {
    cacheNode('aura', { flex: '1 0 0px', width: '360px', order: '1', alignSelf: 'center' });
    queueMutation({
      type: 'move', nodeId: 'aura', newParentId: null, canvasNode: true,
      styles: { position: 'absolute', left: '-556px', top: '4697px' },
    });
    flushNow();

    const aura = parseJSXToNodes(flushed).get('aura');
    expect(aura?.isCanvasNode).toBe(true);
    expect(aura?.styles.flex).toBe('0 0 auto');
    expect(aura?.styles.order).toBeUndefined();
    expect(aura?.styles.alignSelf).toBeUndefined();
    // The exit styles the caller asked for still land.
    expect(aura?.styles.left).toBe('-556px');
    expect(aura?.styles.top).toBe('4697px');
    // Props describing how the node lays out its OWN children are untouched.
    expect(aura?.styles.width).toBe('360px');
    removeNodeFromCache('aura');
  });

  test('leaves a node with no flow props alone (no flex litter)', () => {
    cacheNode('plain', { width: '100px', height: '100px' });
    queueMutation({
      type: 'move', nodeId: 'plain', newParentId: null, canvasNode: true,
      styles: { position: 'absolute', left: '10px', top: '20px' },
    });
    flushNow();

    const plain = parseJSXToNodes(flushed).get('plain');
    expect(plain?.isCanvasNode).toBe(true);
    expect(plain?.styles.flex).toBeUndefined();
    removeNodeFromCache('plain');
  });

  test('a normal reparent into a real parent keeps flex untouched', () => {
    // Only the CANVAS-ROOT move neutralises: moving between flow parents must
    // preserve the child's sizing contract.
    cacheNode('aura', { flex: '1 0 0px' });
    queueMutation({ type: 'move', nodeId: 'aura', newParentId: 'sib', styles: {} });
    flushNow();

    expect(parseJSXToNodes(flushed).get('aura')?.styles.flex).toBe('1 0 0px');
    removeNodeFromCache('aura');
  });

  test('no cache entry → writes nothing rather than guessing', () => {
    queueMutation({
      type: 'move', nodeId: 'aura', newParentId: null, canvasNode: true,
      styles: { position: 'absolute', left: '5px', top: '5px' },
    });
    flushNow();

    // Unchanged from source — the reset never fabricates a value it can't verify.
    expect(parseJSXToNodes(flushed).get('aura')?.styles.flex).toBe('1 0 0px');
  });
});

// ─── renameNode — component instances with data-responsive ──────────────────
// The old `<`-vs-`[` tag heuristic classified any tag whose attrs contain a
// `[` before data-id as a CSS selector — and every responsive instance does
// (`data-responsive='…"_bp":[375,768,1440]}'` precedes data-id). Renaming an
// instance in the Layers panel silently no-op'd: mutation applied, code came
// back byte-identical, the row reverted (user report 2026-07-27).
describe('renameNode', () => {
  // The exact template shape from the live trace: a CSS band selector with
  // the SAME data-id above the tag, and data-responsive (with a JSON array)
  // BEFORE data-id on the instance.
  const TEMPLATE_CODE = `<div data-id="root" data-name="Layout" style={{display: 'flex'}}>
  <style>{\`
  @media (max-width: 768px) and (min-width: 375.02px) {
    [data-id="KaFiBi-1"] { order: -1 !important; }
  }
\`}</style>
  <KaFiBi data-responsive='{"375":{"initialVariant":"mobile"},"_bp":[375,768,1440]}' data-id="KaFiBi-1" data-name="KaFiBi" style={{width: '100%'}}></KaFiBi>
  <div data-id="plain-2" data-name="Plain" style={{width: '10px'}}></div>
</div>`;

  let flushed: string;
  beforeEach(() => {
    flushed = '';
    initMutationQueue(TEMPLATE_CODE, (code) => { flushed = code; }, () => {}, () => {});
  });

  test('renames a COMPONENT INSTANCE whose data-responsive precedes data-id', () => {
    queueMutation({ type: 'renameNode', nodeId: 'KaFiBi-1', name: 'Header' });
    flushNow();
    expect(flushed).toContain('data-id="KaFiBi-1" data-name="Header"');
    // The CSS band selector above the tag is untouched.
    expect(flushed).toContain('[data-id="KaFiBi-1"] { order: -1 !important; }');
  });

  test('still renames plain nodes', () => {
    queueMutation({ type: 'renameNode', nodeId: 'plain-2', name: 'Renamed' });
    flushNow();
    expect(flushed).toContain('data-id="plain-2" data-name="Renamed"');
  });

  test('inserts data-name when the tag has none', () => {
    initMutationQueue(
      `<div data-id="root"><span data-id="bare-3" style={{width: '5px'}}></span></div>`,
      (code) => { flushed = code; }, () => {}, () => {},
    );
    queueMutation({ type: 'renameNode', nodeId: 'bare-3', name: 'Bare' });
    flushNow();
    expect(flushed).toContain('data-id="bare-3" data-name="Bare"');
  });
});
