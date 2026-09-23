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
  // Branch pointer + coarse subscription: the agent-run-lock store (pulled
  // in through modify-file / viewer-mode) reads them. Sandbox is always
  // "main", never locked.
  getActiveBranchId(): string { return MAIN_BRANCH_ID; },
  subscribe(_fn: () => void): () => void { return () => {}; },
};

export const projectVersionAtom = { init: 0 };

export const MAIN_BRANCH_ID = 'main';

/** Editor state (`_meta/`) lives on main whatever branch is active — the
 *  sandbox has no branches, but modify-file imports the predicate. Keep it
 *  in step with project-fs.ts. */
export function isSharedAcrossBranches(path: string): boolean {
  return path.startsWith('_meta/');
}

/** Lazy-install stub — sandbox has no real filesystem, so install is a no-op.
 *  The parent frame is the source of truth for file installs and re-renders
 *  the iframe with a fresh `nodes` map (and an `import X from '@/components/
 *  X'` already resolved on the parent side). */
export function installBuiltInCodeComponent(_fs: unknown, _tag: string): boolean | null {
  return null;
}

/** Same — refresh is a parent-frame concern. */
export function syncBuiltInCodeComponents(_fs: unknown): void {}
