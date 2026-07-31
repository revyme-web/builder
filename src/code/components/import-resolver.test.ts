import { describe, test, expect } from 'vitest';
import { resolveImportPath, extractImports } from './import-resolver';

describe('resolveImportPath', () => {
  test('resolves @/ absolute imports', () => {
    expect(resolveImportPath('@/components/Navbar', 'app/page.tsx')).toBe('components/Navbar.tsx');
    expect(resolveImportPath('@/tokens/colors', 'app/page.tsx')).toBe('tokens/colors.tsx');
  });

  test('returns null for external packages', () => {
    expect(resolveImportPath('react', 'app/page.tsx')).toBeNull();
    expect(resolveImportPath('framer-motion', 'app/page.tsx')).toBeNull();
  });

  test('resolves relative imports', () => {
    const result = resolveImportPath('./Hero', 'components/Navbar.tsx');
    expect(result).toBe('components/Hero.tsx');
  });
});

describe('extractImports', () => {
  test('extracts default imports', () => {
    const code = `import Navbar from '@/components/Navbar';
import Hero from '@/components/Hero';`;
    const imports = extractImports(code);
    expect(imports.get('Navbar')).toBe('@/components/Navbar');
    expect(imports.get('Hero')).toBe('@/components/Hero');
  });

  test('extracts named imports', () => {
    const code = `import { colors, typography } from '@/tokens/design';`;
    const imports = extractImports(code);
    expect(imports.get('colors')).toBe('@/tokens/design');
    expect(imports.get('typography')).toBe('@/tokens/design');
  });

  test('handles aliased imports', () => {
    const code = `import { motion as m } from 'framer-motion';`;
    const imports = extractImports(code);
    expect(imports.get('m')).toBe('framer-motion');
  });

  test('returns empty map for no imports', () => {
    const code = `export default function Foo() { return <div />; }`;
    const imports = extractImports(code);
    expect(imports.size).toBe(0);
  });
});
