import { describe, it, expect, vi } from 'vitest';
vi.mock('@/shared/debug-trace', () => ({ trace: { action: vi.fn(), fn: vi.fn(), error: vi.fn() } }));
import {
  parseRichConditionalProp,
  formatRichConditionalProp,
  classifyCondBranch,
} from './instance-conditional-prop';
import {
  setConditionalInstancePropVarInCode,
  getConditionalInstancePropBranch,
  removeConditionalInstancePropBranchInCode,
} from './instance-prop-overrides';
import { parseJSXToNodes } from '@/code/parsing/parser';

// A Header master with a nested LogoMark instance. `useState(initialVariant)` present → the parent
// variant identifier is `variant`; absent → `initialVariant`.
const HEADER = (logoAttrs: string, withConnections = false) => `'use client';
import { motion } from 'framer-motion';
import LogoMark from '@/components/LogoMark';
function Header({ style, initialVariant = 'default' }) {
  ${withConnections ? 'const [variant, setVariant] = useState(initialVariant);' : ''}
  return (
    <motion.div data-id="root" data-name="Header" style={{ ...style }}>
      <LogoMark data-id="logo-mark" data-name="Logo Mark"${logoAttrs} />
    </motion.div>
  );
}
export default Header;`;

const propOf = (code: string) => code.match(/initialVariant=(?:"[^"]*"|\{[^}]+\})/)?.[0] ?? '';

describe('classifyCondBranch', () => {
  it('quoted = literal, bare identifier = variable, undefined/null = empty literal', () => {
    expect(classifyCondBranch("'variant-2'")).toEqual({ value: 'variant-2', isVar: false });
    expect(classifyCondBranch('logoMarkVariant')).toEqual({ value: 'logoMarkVariant', isVar: true });
    expect(classifyCondBranch('undefined')).toEqual({ value: '', isVar: false });
  });
});

describe('parseRichConditionalProp / formatRichConditionalProp', () => {
  it('round-trips a MIXED literal + variable ternary', () => {
    const expr = "variant === 'variant-3' ? 'variant-2' : variant === 'variant-6' ? logoVar : 'default'";
    const map = parseRichConditionalProp(expr);
    expect(map).toEqual({
      'variant-3': { value: 'variant-2', isVar: false },
      'variant-6': { value: 'logoVar', isVar: true },
      default: { value: 'default', isVar: false },
    });
    expect(formatRichConditionalProp(map!, 'variant')).toBe(expr);
  });

  it('format quotes literals, leaves variables bare', () => {
    const out = formatRichConditionalProp(
      { 'variant-6': { value: 'logoVar', isVar: true }, default: { value: 'default', isVar: false } },
      'variant',
    );
    expect(out).toBe("variant === 'variant-6' ? logoVar : 'default'");
  });
});

describe('setConditionalInstancePropVarInCode — bind a variable on ONE parent variant', () => {
  it('a literal prop → per-variant variable branch + literal else (parent var = initialVariant)', () => {
    const code = HEADER(' initialVariant="default"');
    const out = setConditionalInstancePropVarInCode(code, 'logo-mark', 'LogoMark', 'initialVariant', 'variant-6', 'logoMarkVariant', 'default');
    expect(propOf(out)).toBe("initialVariant={initialVariant === 'variant-6' ? logoMarkVariant : 'default'}");
  });

  it('uses `variant` as the parent var when the master has connections (useState)', () => {
    const code = HEADER(' initialVariant="default"', true);
    const out = setConditionalInstancePropVarInCode(code, 'logo-mark', 'LogoMark', 'initialVariant', 'variant-6', 'logoMarkVariant', 'default');
    expect(propOf(out)).toBe("initialVariant={variant === 'variant-6' ? logoMarkVariant : 'default'}");
  });

  it('PRESERVES an existing per-variant literal override and adds the variable branch', () => {
    const code = HEADER(" initialVariant={initialVariant === 'variant-3' ? 'variant-2' : 'default'}");
    const out = setConditionalInstancePropVarInCode(code, 'logo-mark', 'LogoMark', 'initialVariant', 'variant-6', 'logoMarkVariant', 'default');
    const branch = getConditionalInstancePropBranch(out, 'logo-mark', 'LogoMark', 'initialVariant', 'variant-3');
    expect(branch).toEqual({ value: 'variant-2', isVar: false });   // literal kept
    const v6 = getConditionalInstancePropBranch(out, 'logo-mark', 'LogoMark', 'initialVariant', 'variant-6');
    expect(v6).toEqual({ value: 'logoMarkVariant', isVar: true });  // new var branch
  });

  it('binds even when the instance had NO initialVariant prop (seeds the default)', () => {
    const code = HEADER('');
    const out = setConditionalInstancePropVarInCode(code, 'logo-mark', 'LogoMark', 'initialVariant', 'variant-6', 'logoMarkVariant', 'default');
    expect(propOf(out)).toBe("initialVariant={initialVariant === 'variant-6' ? logoMarkVariant : 'default'}");
  });
});

describe('setConditionalInstancePropVarInCode — base preservation', () => {
  it('keeps an existing GLOBAL variable binding as a BARE variable base (not a quoted literal of its name)', () => {
    const code = HEADER(' initialVariant={seJoReVariant}');
    const out = setConditionalInstancePropVarInCode(code, 'logo-mark', 'LogoMark', 'initialVariant', 'variant-1', 'seJoReVariant1', 'default');
    expect(propOf(out)).toBe("initialVariant={initialVariant === 'variant-1' ? seJoReVariant1 : seJoReVariant}");
  });
});

describe('removeConditionalInstancePropBranchInCode — Reset Override', () => {
  it('drops a branch and collapses to a literal when only a literal default remains', () => {
    const code = HEADER(" initialVariant={initialVariant === 'variant-1' ? seJoReVariant1 : 'default'}");
    const out = removeConditionalInstancePropBranchInCode(code, 'logo-mark', 'LogoMark', 'initialVariant', 'variant-1');
    expect(propOf(out)).toBe('initialVariant="default"');
  });

  it('drops a branch but KEEPS a VARIABLE default as a binding (never flattens it to a literal)', () => {
    const code = HEADER(" initialVariant={initialVariant === 'variant-1' ? seJoReVariant1 : seJoReVariant}");
    const out = removeConditionalInstancePropBranchInCode(code, 'logo-mark', 'LogoMark', 'initialVariant', 'variant-1');
    expect(propOf(out)).toBe('initialVariant={seJoReVariant}');
  });

  it('keeps OTHER variant branches when dropping one', () => {
    const code = HEADER(" initialVariant={initialVariant === 'variant-1' ? seJoReVariant1 : initialVariant === 'variant-2' ? 'variant-3' : 'default'}");
    const out = removeConditionalInstancePropBranchInCode(code, 'logo-mark', 'LogoMark', 'initialVariant', 'variant-1');
    expect(propOf(out)).toBe("initialVariant={initialVariant === 'variant-2' ? 'variant-3' : 'default'}");
  });
});

describe('parser resolves a per-variant VARIABLE branch for the static canvas', () => {
  it('attrConditional.initialVariant resolves the variable to its @pageVariables default variant', () => {
    const code = `'use client';
/** @pageVariables { "variables": [ { "name": "logoVar", "type": "text", "default": "variant-2" } ] } */
import { motion } from 'framer-motion';
import LogoMark from '@/components/LogoMark';
function Header({ style, initialVariant = 'default', logoVar = 'variant-2' }) {
  return <motion.div data-id="root" data-name="Header" style={{ ...style }}>
    <LogoMark data-id="logo-mark" data-name="Logo Mark" initialVariant={initialVariant === 'variant-1' ? logoVar : 'default'} />
  </motion.div>;
}
export default Header;`;
    const nodes = parseJSXToNodes(code);
    expect(nodes.get('logo-mark')?.attrConditional?.initialVariant).toEqual({ 'variant-1': 'variant-2', default: 'default' });
  });
});

describe('getConditionalInstancePropBranch', () => {
  it('returns isVar:true for a variable branch, isVar:false for a literal, null for a missing variant', () => {
    const code = HEADER(" initialVariant={initialVariant === 'variant-6' ? logoVar : 'default'}");
    expect(getConditionalInstancePropBranch(code, 'logo-mark', 'LogoMark', 'initialVariant', 'variant-6')).toEqual({ value: 'logoVar', isVar: true });
    expect(getConditionalInstancePropBranch(code, 'logo-mark', 'LogoMark', 'initialVariant', 'default')).toEqual({ value: 'default', isVar: false });
    expect(getConditionalInstancePropBranch(code, 'logo-mark', 'LogoMark', 'initialVariant', 'variant-9')).toBeNull();
  });

  it('returns null for a plain literal prop (no ternary)', () => {
    const code = HEADER(' initialVariant="default"');
    expect(getConditionalInstancePropBranch(code, 'logo-mark', 'LogoMark', 'initialVariant', 'variant-6')).toBeNull();
  });
});
