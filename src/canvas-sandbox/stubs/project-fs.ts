// Stub for projectFS in sandbox context.
// The sandbox doesn't have the in-memory filesystem.
// Files needed by Renderer are passed via the render command instead.

let _globalsCSS = '';

/** Set globals CSS from parent's render command. */
export function setSandboxGlobalsCSS(css: string): void {
  _globalsCSS = css;
}

export const projectFS = {
  readFile(path: string): string | null {
    if (path === 'app/globals.css') return _globalsCSS;
    return null;
  },
  exists(_path: string): boolean { return false; },
  writeFile() {},
  deleteFile() {},
  listFiles() { return []; },
};

export const projectVersionAtom = { init: 0 };

/** Lazy-install stub — sandbox has no real filesystem, so install is a no-op.
 *  The parent frame is the source of truth for file installs and re-renders
 *  the iframe with a fresh `nodes` map (and an `import X from '@/components/
 *  X'` already resolved on the parent side). */
export function installBuiltInCodeComponent(_fs: unknown, _tag: string): boolean | null {
  return null;
}

/** Same — refresh is a parent-frame concern. */
export function syncBuiltInCodeComponents(_fs: unknown): void {}
