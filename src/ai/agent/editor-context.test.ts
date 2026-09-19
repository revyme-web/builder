import { describe, it, expect, beforeEach } from 'vitest';
import { getDefaultStore } from 'jotai';
import { buildAgentContextBlock } from './editor-context';
import { resetProjectFS } from '@/code/project/project-fs';
import { activeFilePathAtom } from '@/code/project/active-file-store';

const PAGE = `'use client';
import React from 'react';
export default function Page() {
  return (<div data-id="root" data-name="Page" style={{ position: 'relative' }}>
    <div data-id="hero" data-name="Hero" style={{ position: 'relative' }}></div>
  </div>);
}`;

describe('agent editor context', () => {
  beforeEach(() => {
    resetProjectFS(new Map([['app/page.client.tsx', PAGE]]));
    getDefaultStore().set(activeFilePathAtom, 'app/page.client.tsx');
  });

  it('names the file being edited and the active breakpoint', () => {
    const block = buildAgentContextBlock();
    expect(block).toContain('## Current editor context');
    expect(block).toContain('app/page.client.tsx');
    expect(block).toMatch(/Active viewport width: \d+px/);
  });

  it('always carries the dialect card — the rules a written file must pass', () => {
    const block = buildAgentContextBlock();
    expect(block).toContain('Revyme dialect');
    expect(block).toContain('NODE_MISSING_POSITION');
    expect(block).toContain('FLEX_CHILD_MISSING_ORDER');
  });

  it('reports the selection state explicitly rather than omitting it', () => {
    expect(buildAgentContextBlock()).toContain('No element selected.');
  });

  it('never throws, even with an empty project', () => {
    resetProjectFS(new Map());
    expect(() => buildAgentContextBlock()).not.toThrow();
    expect(buildAgentContextBlock()).toContain('Revyme dialect');
  });

  it('is a plain string safe to send as a message', () => {
    const block = buildAgentContextBlock();
    expect(typeof block).toBe('string');
    expect(JSON.parse(JSON.stringify({ block })).block).toBe(block);
  });
});
