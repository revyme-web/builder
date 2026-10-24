// ticker-wrapper.test.ts — the Ticker effect's `<RevymeTicker>` wrapper through
// the parser and the mutation queue: the wrapper is transparent to the node
// tree, carries `node.ticker`, and survives every other mutation (lifted and
// restored around it like `<Override>`), with an override on the same frame
// staying INSIDE it.
import { describe, it, expect, beforeEach } from 'vitest';
import { projectFS } from '@/code/project/project-fs';
import { setActiveFilePath, flushNow, initMutationQueue, queueMutation } from './mutation-queue';
import { setBumpVersion } from '@/code/project/modify-file';
import { parseJSXToNodes } from '@/code/parsing/parser';
import { TICKER_DEFAULTS } from '@/shared/ticker-config';

const FILE = 'app/page.client.tsx';

const PAGE = `'use client';
import React from 'react';
import { motion } from 'framer-motion';
import { RevymeTicker } from '@revyme/runtime';

export default function Page() {
  return (
    <div data-id="root" style={{ position: 'relative' }}>
      <RevymeTicker speed={60} direction="right" hoverSpeed={0.5} draggable fade={32}><div data-id="logos" style={{ display: 'flex', gap: '20px' }}>
        <div data-id="l1" style={{ width: '100px' }} />
        <div data-id="l2" style={{ width: '100px' }} />
      </div></RevymeTicker>
      <p data-id="t1" style={{ color: 'red' }}>Hello</p>
    </div>
  );
}
`;

const read = () => projectFS.readFile(FILE)!;

describe('parser: <RevymeTicker> wrapper', () => {
  it('is transparent and puts the config on the frame', () => {
    const nodes = parseJSXToNodes(PAGE);
    const logos = nodes.get('logos')!;
    expect(logos.ticker).toEqual({ speed: 60, direction: 'right', hoverSpeed: 0.5, draggable: true, fade: 32 });
    expect(logos.parentId).toBe('root');
    expect(nodes.get('root')!.children).toEqual(['logos', 't1']);
    expect(logos.children).toEqual(['l1', 'l2']);
    expect([...nodes.values()].some(n => n.type === 'RevymeTicker')).toBe(false);
    expect(nodes.get('l1')!.ticker).toBeUndefined();
  });

  it('looks through an Override inside the ticker, and through a visibility conditional', () => {
    const withOverride = PAGE.replace(
      /(<RevymeTicker[^>]*>)(<div data-id="logos"[\s\S]*?<\/div>)(<\/RevymeTicker>)/,
      '$1<Override with={withX}>$2</Override>$3',
    );
    const nodes = parseJSXToNodes(withOverride);
    expect(nodes.get('logos')!.ticker?.speed).toBe(60);
    expect(nodes.get('logos')!.codeOverrides).toEqual(['withX']);
    expect(nodes.get('logos')!.parentId).toBe('root');
  });
});

describe('mutation queue: the wrapper rides along every other mutation', () => {
  beforeEach(() => {
    projectFS.writeFile(FILE, PAGE);
    setActiveFilePath(FILE);
    setBumpVersion(() => {});
    initMutationQueue(PAGE, c => projectFS.writeFile(FILE, c));
  });

  it('a style edit on the frame keeps the wrapper', () => {
    queueMutation({ type: 'updateStyles', nodeId: 'logos', styles: { gap: '40px' } });
    flushNow();
    const out = read();
    expect(out).toMatch(/<RevymeTicker speed=\{60\} direction="right" hoverSpeed=\{0\.5\} draggable fade=\{32\}><div data-id="logos"[^>]*gap: '40px'/);
    expect(out.match(/<\/RevymeTicker>/g)).toHaveLength(1);
  });

  it('removing a child keeps the wrapper; removing the frame drops it', () => {
    queueMutation({ type: 'removeNode', nodeId: 'l2' });
    flushNow();
    expect(read()).toMatch(/<RevymeTicker [^>]*><div data-id="logos"/);
    expect(read()).not.toContain('data-id="l2"');
    queueMutation({ type: 'removeNode', nodeId: 'logos' });
    flushNow();
    expect(read()).not.toContain('<RevymeTicker');
    expect(read()).toContain('data-id="t1"');
  });

  it('setTicker updates and removes', () => {
    queueMutation({ type: 'setTicker', nodeId: 'logos', ticker: { ...TICKER_DEFAULTS, speed: 200 } });
    flushNow();
    expect(read()).toContain('<RevymeTicker speed={200} direction="left"><div data-id="logos"');
    queueMutation({ type: 'setTicker', nodeId: 'logos', ticker: null });
    flushNow();
    expect(read()).not.toContain('<RevymeTicker');
    expect(parseJSXToNodes(read()).get('logos')!.ticker).toBeUndefined();
  });

  it('setTicker on a fresh frame wraps it and imports the runtime', () => {
    queueMutation({ type: 'setTicker', nodeId: 't1', ticker: TICKER_DEFAULTS });
    flushNow();
    const out = read();
    expect(out).toContain('<RevymeTicker speed={80} direction="left"><p data-id="t1"');
    expect(out).toMatch(/import \{[^}]*\bRevymeTicker\b[^}]*\} from '@revyme\/runtime';/);
    expect(out.match(/<RevymeTicker /g)).toHaveLength(2);
  });
});
