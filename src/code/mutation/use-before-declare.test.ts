import { describe, it, expect } from 'vitest';
import { parse } from '@babel/parser';
import { findUseBeforeDeclare } from './use-before-declare';
import { validateGeneratedCode } from './mutation-queue';

const find = (code: string) =>
  findUseBeforeDeclare(parse(code, { sourceType: 'module', plugins: ['jsx', 'typescript'] }));

describe('findUseBeforeDeclare — flags what throws', () => {
  it('a hook dependency array above the state it names (overlay, 2026-10-06)', () => {
    const hit = find(`export default function Page() {
  useEffect(() => {
    if (!menuOpen) return;
  }, [menuOpen]);
  const [menuOpen, setMenuOpen] = useState(false);
  return <div />;
}`);
    expect(hit).toEqual({ name: 'menuOpen', useLine: 4, declLine: 5 });
  });

  it('appear hooks above their in-view consts (2026-06-15)', () => {
    const hit = find(`export default function Page() {
  useEffect(() => { if (heroBgInView) { animate(heroBgAppear, 1); } }, [heroBgInView]);
  const heroBgRef = useRef(null);
  const heroBgInView = useInView(heroBgRef);
  const heroBgAppear = useMotionValue(0);
  return <div ref={heroBgRef} />;
}`);
    expect(hit?.name).toBe('heroBgInView');
  });

  it('module-scope JSX naming a component declared below it', () => {
    expect(find(`const canvasNodes = <Leaf />;
const Leaf = () => null;`)?.name).toBe('Leaf');
  });

  it('a const read in its own initializer', () => {
    expect(find(`function f() { const x = x + 1; return x; }`)?.name).toBe('x');
  });
});

describe('findUseBeforeDeclare — leaves what runs later alone', () => {
  it('reads inside effect bodies, handlers and callbacks', () => {
    expect(find(`export default function Page() {
  useEffect(() => { console.log(later); }, []);
  const handler = () => setOpen(!open);
  const [open, setOpen] = useState(false);
  const later = 1;
  return <button onClick={() => setOpen(!open)}>{[1].map(() => later)}</button>;
}`)).toBeNull();
  });

  it('a component function referencing module consts declared after it', () => {
    expect(find(`export default function Page() { return <div>{canvasNodes}</div>; }
const canvasNodes = <></>;`)).toBeNull();
  });

  it('hoisted function declarations', () => {
    expect(find(`const el = render();
function render() { return 1; }`)).toBeNull();
  });

  it('type-only positions', () => {
    expect(find(`let a: typeof B;
const B = 1;`)).toBeNull();
  });

  it('class bodies', () => {
    expect(find(`class A { x = later; m() { return later; } }
const later = 1;`)).toBeNull();
  });

  it('normal top-down order', () => {
    expect(find(`export default function Page() {
  const [open, setOpen] = useState(false);
  useEffect(() => {}, [open]);
  return <div>{open && <span />}</div>;
}`)).toBeNull();
  });
});

describe('validateGeneratedCode', () => {
  it('rejects a use-before-declare with a message naming the variable and lines', () => {
    const msg = validateGeneratedCode(`import { useState, useEffect } from 'react';
export default function Page() {
  useEffect(() => {}, [menuOpen]);
  const [menuOpen, setMenuOpen] = useState(false);
  return <div />;
}`);
    expect(msg).toContain('`menuOpen` is used at line 3 before its declaration at line 4');
    expect(msg).toContain("Cannot access 'menuOpen' before initialization");
  });
});
