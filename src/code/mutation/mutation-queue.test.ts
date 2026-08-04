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

// A canvas node has no viewports, so the per-viewport @media overrides it
// carried must leave with it. They weren't being shed: a node hidden on tablet,
// dragged out to the canvas and dragged back in came back STILL hidden on
// tablet, because ENTRY only clears the override for the viewport it lands in
// (user report 2026-08-04). This is the wiring check — the generator-level
// behaviour lives in generator-styles.test.ts.
describe('exit-to-canvas sheds per-viewport @media overrides', () => {
  const HIDDEN_ON_TABLET = `<div data-id="root" style={{position: 'relative'}}>
  <style>{\`
    @media (max-width: 768px) {
      [data-id="aura"] { display: none !important; }
      [data-id="aura-kid"] { font-size: 11px !important; }
      [data-id="sib"] { display: none !important; }
    }
  \`}</style>
  <div data-id="aura" style={{position: 'absolute'}}><p data-id="aura-kid" style={{position: 'relative'}}>x</p></div>
  <div data-id="sib" style={{position: 'absolute'}}></div>
</div>`;

  let flushed: string;
  beforeEach(() => {
    flushed = '';
    initMutationQueue(HIDDEN_ON_TABLET, (code) => { flushed = code; }, () => {}, () => {});
  });

  test('the dragged node and its subtree lose their overrides; siblings keep theirs', () => {
    cacheNode('aura', { position: 'absolute' });
    queueMutation({
      type: 'move', nodeId: 'aura', newParentId: null, canvasNode: true,
      styles: { position: 'absolute', left: '100px', top: '50px' },
    });
    flushNow();

    // Gone: the node would otherwise still be display:none on tablet after
    // being dragged back in.
    expect(flushed).not.toContain(`[data-id="aura"]`);
    // Gone: descendants leave with the node.
    expect(flushed).not.toContain(`[data-id="aura-kid"]`);
    // Kept: an untouched sibling's override is none of this move's business.
    expect(flushed).toContain(`[data-id="sib"] { display: none !important; }`);
    // And the exit itself still worked.
    expect(parseJSXToNodes(flushed).get('aura')?.isCanvasNode).toBe(true);
    removeNodeFromCache('aura');
  });

  test('a normal reparent (not to canvas) keeps the overrides', () => {
    cacheNode('aura', { position: 'absolute' });
    queueMutation({ type: 'move', nodeId: 'aura', newParentId: 'sib', styles: {} });
    flushNow();

    expect(flushed).toContain(`[data-id="aura"]`);
    removeNodeFromCache('aura');
  });
});

// Every element drag drops through `flushNow` — the queue is HELD for the whole
// gesture, then DragCoordinator.reset() drains it here. So this is the only
// flush path that matters for drags, and it was the one path that never asked
// the render-skip gate (`onBeforeFlush` → decideFlushRenderGate). That gate is
// what stops a render-resolved mutation having its render marked away.
//
// The bug it let through (user report 2026-08-04): drag a node out of the TABLET
// replica, then back into the DESKTOP primary. The entry queues
// `updateContainerStyle {display:''}` to drop the "hidden on every non-source
// viewport" rule the extraction wrote. The drop drained it and the code came out
// correct — but DragCoordinator had already armed a position-only render skip
// (it inspects the strategy's position updates, which know nothing about the
// queue), so the render that rebuilds the @media→@container CSS was dropped and
// the stale rule kept the node `display:none` on desktop. It stayed visible on
// tablet, which is the "offset jump" the user was actually seeing.
describe('flushNow consults the render-skip gate', () => {
  const CODE = `<div data-id="root" style={{position: 'relative'}}>
  <div data-id="aura" style={{position: 'absolute'}}></div>
</div>`;

  let seen: string[][];
  beforeEach(() => {
    seen = [];
    initMutationQueue(CODE, () => {}, (types) => { seen.push([...types]); }, () => {});
  });

  test('hands the drained mutation types to the gate', () => {
    queueMutation({ type: 'updateContainerStyle', nodeId: 'aura', maxWidth: 1061, styles: { display: '' } });
    flushNow();

    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('updateContainerStyle');
  });

  test('a render-resolved mutation is visible to the gate so it can DISARM the skip', async () => {
    const { flushIsFullyImperative } = await import('./render-resolved-mutations');
    // The canvas→primary entry drop: a position commit AND the override removal.
    queueMutation({ type: 'updateStyles', nodeId: 'aura', styles: { left: '10px' } });
    queueMutation({ type: 'updateContainerStyle', nodeId: 'aura', maxWidth: 1061, styles: { display: '' } });
    flushNow();

    // Not fully imperative ⇒ decideFlushRenderGate returns 'disarm-skip' ⇒
    // clearCanvasUpdate() ⇒ the post-drop render actually runs and rebuilds the
    // @container CSS without the stale hide rule.
    expect(flushIsFullyImperative(seen[0])).toBe(false);
  });

  test('a pure position drop still qualifies for the skip (the optimisation survives)', async () => {
    const { flushIsFullyImperative } = await import('./render-resolved-mutations');
    queueMutation({ type: 'updateStyles', nodeId: 'aura', styles: { left: '10px', top: '20px' } });
    flushNow();

    expect(flushIsFullyImperative(seen[0])).toBe(true);
  });

  test('an empty drain does not call the gate at all', () => {
    flushNow();
    expect(seen).toHaveLength(0);
  });
});

// The ENTRY unhide, end to end through the real generator. Two things have to
// hold at once, and they pull in opposite directions:
//   · the entered viewport's hide must be GONE (else the node is invisible in
//     the viewport the user just dragged it into), and
//   · every OTHER viewport's hide must SURVIVE — that is what makes a
//     tablet-only node stay tablet-only after a round trip through the canvas.
// It also pins the shape of the fix: the rule is removed from the SOURCE, never
// papered over with an inline `display`, so nothing is cemented into the user's
// code by the drag.
describe('entry unhide — per-viewport display override removal', () => {
  const HIDDEN_ON_BOTH = `<div data-id="root" style={{position: 'relative'}}>
  <style>{\`
    @media (max-width: 1440px) and (min-width: 768.02px) {
      [data-id="aura"] { display: none !important; }
    }
    @media (max-width: 768px) {
      [data-id="aura"] { display: none !important; }
      [data-id="sib"] { display: none !important; }
    }
  \`}</style>
  <div data-id="aura" style={{position: 'absolute'}}></div>
  <div data-id="sib" style={{position: 'absolute'}}></div>
</div>`;

  let flushed: string;
  beforeEach(() => {
    flushed = '';
    initMutationQueue(HIDDEN_ON_BOTH, (code) => { flushed = code; }, () => {}, () => {});
  });

  test('entering DESKTOP drops the desktop hide and keeps the tablet one', () => {
    queueMutation({ type: 'updateContainerStyle', nodeId: 'aura', maxWidth: 1440, styles: { display: '' } });
    flushNow();

    // Desktop band is gone…
    expect(flushed).not.toMatch(/min-width:\s*768\.02px/);
    // …tablet still hides it (a node extracted from tablet stays tablet-only).
    expect(flushed).toMatch(/@media \(max-width: 768px\)[\s\S]*\[data-id="aura"\][\s\S]*display: none/);
    // No inline display was cemented onto the element by the unhide.
    const aura = parseJSXToNodes(flushed).get('aura');
    expect(aura?.styles.display).toBeUndefined();
  });

  test('entering TABLET drops the tablet hide and keeps the desktop one', () => {
    queueMutation({ type: 'updateContainerStyle', nodeId: 'aura', maxWidth: 768, styles: { display: '' } });
    flushNow();

    expect(flushed).toMatch(/min-width:\s*768\.02px[\s\S]*\[data-id="aura"\][\s\S]*display: none/);
    // aura's tablet rule is gone; sib's is untouched.
    expect(flushed).toMatch(/@media \(max-width: 768px\)[\s\S]*\[data-id="sib"\][\s\S]*display: none/);
    const tabletBlock = flushed.slice(flushed.indexOf('@media (max-width: 768px)'));
    expect(tabletBlock).not.toContain('[data-id="aura"]');
    expect(parseJSXToNodes(flushed).get('aura')?.styles.display).toBeUndefined();
  });
});

// The REPLICA entry's end state, through the real generator. "Exists only on
// tablet" is expressed as a PAIR: base inline `display:'none'` (hides it
// everywhere) + a tablet `@media` override that reveals it there. Both halves
// must survive the flush — the drag now commits them mid-gesture rather than at
// mouseup, so this pins that the synchronous commit produces the same code the
// deferred one did.
describe('replica entry — the base-hide + per-vp-unset pair', () => {
  const CANVAS_NODE = `<div data-id="root" style={{position: 'relative'}}>
  <div data-id="aura" style={{position: 'absolute'}}></div>
</div>`;

  let flushed: string;
  beforeEach(() => {
    flushed = '';
    initMutationQueue(CANVAS_NODE, (code) => { flushed = code; }, () => {}, () => {});
  });

  test('commits both halves: inline display:none and the tablet unset', () => {
    // What the entry queues when a canvas node enters the tablet replica.
    queueMutation({ type: 'updateStyles', nodeId: 'aura', styles: { display: 'none' } });
    queueMutation({ type: 'updateContainerStyle', nodeId: 'aura', maxWidth: 768, styles: { display: 'unset' } });
    flushNow();

    // Half one — the base hide, so the node shows on no OTHER viewport.
    expect(parseJSXToNodes(flushed).get('aura')?.styles.display).toBe('none');
    // Half two — the tablet rule that reveals it there. This is the half that
    // needs a <style> re-render, and the half the drag used to defer.
    expect(flushed).toMatch(/@media \(max-width: 768px\)[\s\S]*\[data-id="aura"\][\s\S]*display: unset/);
  });

  test('a later entry into the primary lifts the base hide without touching tablet', () => {
    queueMutation({ type: 'updateStyles', nodeId: 'aura', styles: { display: 'none' } });
    queueMutation({ type: 'updateContainerStyle', nodeId: 'aura', maxWidth: 768, styles: { display: 'unset' } });
    flushNow();
    // …then the node is dragged out and back into the primary: the base hide is
    // cleared ('' removes the property) and tablet's rule is left alone.
    queueMutation({ type: 'updateStyles', nodeId: 'aura', styles: { display: '' } });
    flushNow();

    expect(parseJSXToNodes(flushed).get('aura')?.styles.display).toBeUndefined();
    expect(flushed).toMatch(/@media \(max-width: 768px\)[\s\S]*\[data-id="aura"\]/);
  });
});
