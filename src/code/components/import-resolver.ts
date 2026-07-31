// import-resolver.ts — Resolve import paths to ProjectFS file paths.
// Maps '@/components/Navbar' → 'components/Navbar.tsx'
// Pure functions, no side effects.

import { trace } from '@/shared/debug-trace';

/**
 * Resolve an import specifier to a ProjectFS file path.
 * Handles:
 *   '@/components/Navbar' → 'components/Navbar.tsx'
 *   './Hero'              → 'components/Hero.tsx' (relative to currentFile)
 *   '../tokens/colors'    → 'tokens/colors.ts' (relative)
 */
export function resolveImportPath(importSpec: string, currentFile: string): string | null {
  let resolved: string;

  if (importSpec.startsWith('@/')) {
    // Absolute from project root: @/components/Navbar → components/Navbar
    resolved = importSpec.slice(2);
  } else if (importSpec.startsWith('./') || importSpec.startsWith('../')) {
    // Relative to current file
    const currentDir = currentFile.includes('/') ? currentFile.slice(0, currentFile.lastIndexOf('/')) : '';
    resolved = normalizePath(currentDir + '/' + importSpec);
  } else {
    // External package (react, framer-motion, etc.) — not a project file
    return null;
  }

  // Try extensions in order
  for (const ext of ['.tsx', '.ts', '.jsx', '.js', '/index.tsx', '/index.ts']) {
    const candidate = resolved + ext;
    // We don't check ProjectFS here — caller does. We just return the resolved path.
    // This keeps the function pure.
    if (!resolved.includes('.')) {
      return resolved + ext.replace('/index', '/index');
    }
  }

  // Already has extension
  if (resolved.match(/\.(tsx?|jsx?|json)$/)) {
    return resolved;
  }

  // Default: try .tsx
  return resolved + '.tsx';
}

/**
 * Extract import statements from code.
 * Returns a map of local name → import specifier.
 * e.g. { 'Navbar': '@/components/Navbar', 'colors': '@/tokens/colors' }
 */
// Cache the whole-file import scan by code. `importRegex.exec(code)` walks the ENTIRE source, and the import
// RESOLVER calls this per component instance PER FRAME during a drag (the trace's `extractImports ×2/frame`
// resolving Header/StartTrialButton against the page) — so on a big variable-heavy file the O(file size) scan
// fired 60×/sec. The result is a read-only name→source Map (every caller only `.get()`s it), so it's safe to
// return the cached instance. Bounded FIFO; any code edit is a new key.
const _importsCache = new Map<string, Map<string, string>>();
const IMPORTS_CACHE_MAX = 8;

export function extractImports(code: string): Map<string, string> {
  const cached = _importsCache.get(code);
  if (cached) return cached;
  const imports = new Map<string, string>();

  // Match: import Foo from 'path'
  //        import { Foo } from 'path'
  //        import { Foo, Bar } from 'path'
  //        import { Foo as Baz } from 'path'
  const importRegex = /import\s+(?:(\w+)|(?:\{([^}]+)\}))\s+from\s+['"]([^'"]+)['"]/g;

  let match;
  while ((match = importRegex.exec(code)) !== null) {
    const defaultImport = match[1];
    const namedImports = match[2];
    const source = match[3];

    if (defaultImport) {
      imports.set(defaultImport, source);
    }

    if (namedImports) {
      for (const part of namedImports.split(',')) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        // Handle 'Foo as Bar'
        const asMatch = trimmed.match(/(\w+)\s+as\s+(\w+)/);
        if (asMatch) {
          imports.set(asMatch[2], source);
        } else {
          imports.set(trimmed, source);
        }
      }
    }
  }

  _importsCache.set(code, imports);
  if (_importsCache.size > IMPORTS_CACHE_MAX) {
    const oldest = _importsCache.keys().next().value;
    if (oldest !== undefined) _importsCache.delete(oldest);
  }
  trace.fn('extractImports', { count: imports.size, names: [...imports.keys()] });
  return imports;
}

/** Normalize path segments (resolve .. and .) */
function normalizePath(path: string): string {
  const parts = path.split('/').filter(Boolean);
  const result: string[] = [];

  for (const part of parts) {
    if (part === '.') continue;
    if (part === '..') { result.pop(); continue; }
    result.push(part);
  }

  return result.join('/');
}
