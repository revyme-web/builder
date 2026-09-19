import { describe, it, expect } from 'vitest';
import { parse } from '@babel/parser';
import * as t from '@babel/types';
import { runEditabilityRules } from './rules';
import type { OracleViolation } from '../../checks/shared';

function parseCode(code: string): t.File {
  return parse(code, { sourceType: 'module', plugins: ['jsx', 'typescript'] });
}

function codes(vs: OracleViolation[]): string[] {
  return vs.map((v) => v.code);
}

describe('oracle/extensions/editability/rules', () => {
  describe('MOTION_PROPS_ON_INSTANCE', () => {
    it('flags motion props on a PascalCase component instance', () => {
      const code = `
        function Page() {
          return (
            <Card data-id="card-1" whileHover={{ scale: 1.05 }} />
          );
        }
        export default function App() { return null; }
      `;
      const ast = parseCode(code);
      const v: OracleViolation[] = [];
      runEditabilityRules(code, ast, v, { kind: 'page' });
      expect(codes(v)).toContain('MOTION_PROPS_ON_INSTANCE');
      expect(v.find((x) => x.code === 'MOTION_PROPS_ON_INSTANCE')!.elementId).toBe('card-1');
    });

    it('does NOT flag motion.div (a motion element, not an instance)', () => {
      const code = `
        function Page() {
          return (
            <motion.div data-id="card-1" whileHover={{ scale: 1.05 }} />
          );
        }
        export default function App() { return null; }
      `;
      const ast = parseCode(code);
      const v: OracleViolation[] = [];
      runEditabilityRules(code, ast, v, { kind: 'page' });
      expect(codes(v)).not.toContain('MOTION_PROPS_ON_INSTANCE');
    });

    it('does NOT flag a Link (instance tag exempt)', () => {
      const code = `
        function Page() {
          return (
            <Link data-id="cta" whileHover={{ scale: 1.05 }} href="/x" />
          );
        }
        export default function App() { return null; }
      `;
      const ast = parseCode(code);
      const v: OracleViolation[] = [];
      runEditabilityRules(code, ast, v, { kind: 'page' });
      expect(codes(v)).not.toContain('MOTION_PROPS_ON_INSTANCE');
    });

    it('does NOT flag a MotionLink (instance tag exempt)', () => {
      const code = `
        function Page() {
          return (
            <MotionLink data-id="cta" whileHover={{ scale: 1.05 }} href="/x" />
          );
        }
        export default function App() { return null; }
      `;
      const ast = parseCode(code);
      const v: OracleViolation[] = [];
      runEditabilityRules(code, ast, v, { kind: 'page' });
      expect(codes(v)).not.toContain('MOTION_PROPS_ON_INSTANCE');
    });

    it('does NOT flag a regular element with a motion prop (lowercase tag)', () => {
      const code = `
        function Page() {
          return (
            <div data-id="card-1" whileHover={{ scale: 1.05 }} />
          );
        }
        export default function App() { return null; }
      `;
      const ast = parseCode(code);
      const v: OracleViolation[] = [];
      runEditabilityRules(code, ast, v, { kind: 'page' });
      expect(codes(v)).not.toContain('MOTION_PROPS_ON_INSTANCE');
    });

    it('flags any motion prop name from MOTION_PROP_NAMES (animate/initial/exit)', () => {
      const code = `
        function Page() {
          return (
            <Card data-id="c" animate={{ opacity: 1 }} />
          );
        }
        export default function App() { return null; }
      `;
      const ast = parseCode(code);
      const v: OracleViolation[] = [];
      runEditabilityRules(code, ast, v, { kind: 'page' });
      expect(codes(v)).toContain('MOTION_PROPS_ON_INSTANCE');
    });
  });

  describe('PAGE_VAR_UNDECLARED', () => {
    it('flags a setX call where X is NOT declared in @pageVariables', () => {
      const code = `/** @pageVariables { "variables": [ { "name": "declared", "type": "number" } ] } */
function Page() {
  return (
    <button data-id="b" onClick={() => setGhost(0.5)}>x</button>
  );
}
export default function App() { return null; }
`;
      const ast = parseCode(code);
      const v: OracleViolation[] = [];
      runEditabilityRules(code, ast, v, { kind: 'page' });
      expect(codes(v)).toContain('PAGE_VAR_UNDECLARED');
      const vio = v.find((x) => x.code === 'PAGE_VAR_UNDECLARED')!;
      expect(vio.message).toMatch(/setGhost|Ghost/);
      expect(vio.message).toMatch(/@pageVariables/);
      expect(vio.elementId).toBe('b');
    });

    it('does NOT flag when the variable IS declared', () => {
      const code = `/** @pageVariables { "variables": [ { "name": "fade", "type": "number" } ] } */
function Page() {
  return (
    <button data-id="b" onClick={() => setFade(0.5)}>x</button>
  );
}
export default function App() { return null; }
`;
      const ast = parseCode(code);
      const v: OracleViolation[] = [];
      runEditabilityRules(code, ast, v, { kind: 'page' });
      expect(codes(v)).not.toContain('PAGE_VAR_UNDECLARED');
    });

    it('does NOT flag when kind is not page (component is exempt)', () => {
      const code = `function Page() {
  return (
    <button data-id="b" onClick={() => setGhost(0.5)}>x</button>
  );
}
export default function App() { return null; }
`;
      const ast = parseCode(code);
      const v: OracleViolation[] = [];
      runEditabilityRules(code, ast, v, { kind: 'component' });
      expect(codes(v)).not.toContain('PAGE_VAR_UNDECLARED');
    });

    it('does NOT flag when kind is code-component (also exempt)', () => {
      const code = `function Page() {
  return (
    <button data-id="b" onClick={() => setGhost(0.5)}>x</button>
  );
}
export default function App() { return null; }
`;
      const ast = parseCode(code);
      const v: OracleViolation[] = [];
      runEditabilityRules(code, ast, v, { kind: 'code-component' });
      expect(codes(v)).not.toContain('PAGE_VAR_UNDECLARED');
    });

    it('does NOT flag a setX with a non-literal argument (user-authored code)', () => {
      const code = `/** @pageVariables { "variables": [ { "name": "fade", "type": "number" } ] } */
function Page() {
  const other = 0.5;
  return (
    <button data-id="b" onClick={() => setFade(other)}>x</button>
  );
}
export default function App() { return null; }
`;
      const ast = parseCode(code);
      const v: OracleViolation[] = [];
      runEditabilityRules(code, ast, v, { kind: 'page' });
      expect(codes(v)).not.toContain('PAGE_VAR_UNDECLARED');
    });

    it('flags setX inside a block body too', () => {
      const code = `/** @pageVariables { "variables": [ { "name": "declared", "type": "number" } ] } */
function Page() {
  return (
    <button data-id="b" onMouseEnter={() => { setGhost(0.5); }}>x</button>
  );
}
export default function App() { return null; }
`;
      const ast = parseCode(code);
      const v: OracleViolation[] = [];
      runEditabilityRules(code, ast, v, { kind: 'page' });
      expect(codes(v)).toContain('PAGE_VAR_UNDECLARED');
    });

    it('does NOT flag anything when no variables are declared (no rule-trip spam)', () => {
      const code = `function Page() {
  return (
    <button data-id="b" onClick={() => setGhost(0.5)}>x</button>
  );
}
export default function App() { return null; }
`;
      const ast = parseCode(code);
      const v: OracleViolation[] = [];
      runEditabilityRules(code, ast, v, { kind: 'page' });
      expect(codes(v)).not.toContain('PAGE_VAR_UNDECLARED');
    });
  });

  describe('integration: both rules in one pass', () => {
    it('flags both an instance motion prop AND an undeclared setter', () => {
      const code = `/** @pageVariables { "variables": [ { "name": "declared", "type": "number" } ] } */
function Page() {
  return (
    <div>
      <Card data-id="card-1" whileHover={{ scale: 1.05 }} />
      <button data-id="b" onClick={() => setGhost(0.5)}>x</button>
    </div>
  );
}
export default function App() { return null; }
`;
      const ast = parseCode(code);
      const v: OracleViolation[] = [];
      runEditabilityRules(code, ast, v, { kind: 'page' });
      expect(codes(v)).toContain('MOTION_PROPS_ON_INSTANCE');
      expect(codes(v)).toContain('PAGE_VAR_UNDECLARED');
    });
  });
});