// motion-tag.test.ts — motion props on a plain tag are silently dead.
//
// User report 2026-08-08: a component root retagged `motion.div` → `nav` kept
// `layout`, `variants`, `animate` and `onTap`, all of which became inert DOM
// attributes. No warning, no parse error, and the canvas (which renders
// statically, without motion) looked identical — only live lost the animation.
// Codegen now preserves the prefix; this catches the AI/MCP path, which writes
// the tag directly and bypasses codegen entirely.

import { describe, it, expect } from 'vitest';
import { parse } from '@babel/parser';
import { checkMotionPropsNeedMotionTag } from './motion-tag';
import type { OracleViolation } from './shared';

const run = (code: string): OracleViolation[] => {
  const ast = parse(code, { sourceType: 'module', plugins: ['jsx', 'typescript'] }) as any;
  const v: OracleViolation[] = [];
  checkMotionPropsNeedMotionTag(ast, v);
  return v;
};

describe('checkMotionPropsNeedMotionTag', () => {
  it('flags the reported shape — a nav root with layout/variants/animate', () => {
    const v = run(`
      const C = () => <nav layout={true} data-id="frame-1b" variants={xVariants} animate={['default', variant]}>x</nav>;
    `);
    expect(v).toHaveLength(1);
    expect(v[0].code).toBe('MOTION_PROPS_ON_PLAIN_TAG');
    expect(v[0].tier).toBe(2);
    expect(v[0].elementId).toBe('frame-1b');
    // The message names the props and states the fix outright.
    expect(v[0].message).toContain('layout');
    expect(v[0].message).toContain('variants');
    expect(v[0].message).toContain('<motion.nav>');
  });

  it('passes a proper motion tag', () => {
    expect(run(`const C = () => <motion.nav layout={true} variants={v}>x</motion.nav>;`)).toHaveLength(0);
  });

  it('passes MotionLink — the motion.create(Link) wrapper', () => {
    expect(run(`const C = () => <MotionLink layout={true} animate={a}>x</MotionLink>;`)).toHaveLength(0);
  });

  it('leaves component tags alone — they may forward to a motion root', () => {
    expect(run(`const C = () => <FeKaWo animate={a} initialVariant="default" />;`)).toHaveLength(0);
  });

  it('ignores a plain element with no motion props', () => {
    expect(run(`const C = () => <nav style={{ display: 'flex' }} className="x">x</nav>;`)).toHaveLength(0);
  });

  it('catches the tap/hover handlers too — a dead onTap is a dead interaction', () => {
    const v = run(`const C = () => <section onTap={() => setVariant('open')}>x</section>;`);
    expect(v).toHaveLength(1);
    expect(v[0].message).toContain('onTap');
  });

  it('flags every offending element, not just the first', () => {
    const v = run(`
      const C = () => <div>
        <nav layout={true}>a</nav>
        <section whileHover={{ scale: 1.1 }}>b</section>
      </div>;
    `);
    expect(v).toHaveLength(2);
  });

  it('does not flag `style` / `className` — those work anywhere', () => {
    expect(run(`const C = () => <div style={{ x: 1 }} className="a" id="b" />;`)).toHaveLength(0);
  });
});
