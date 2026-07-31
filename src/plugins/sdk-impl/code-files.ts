// plugins/sdk-impl/code-files.ts — codeFiles.* namespace.
//
// Pass 2: list/get/setContent/create/remove/rename — all direct
// projectFS operations. Versioning, lint, typecheck, navigateTo
// defer to later passes (they need version-history infra +
// TypeScript tooling integration).

import { getDefaultStore } from 'jotai';
import { projectFS, projectVersionAtom } from '@/code/project/project-fs';
import { modifyProjectFile } from '@/code/project/modify-file';
import { syncImports } from '@/code/mutation/mutation-queue';
import { componentEditorFileAtom } from '@/code/stores/component-editor-store';
import type { CodeFileInfo } from '@revyme/plugin-sdk';
import type { RpcHandler } from '../plugin-types';
import { trace } from '@/shared/debug-trace';

const store = getDefaultStore();

const isCodeFilePath = (p: string) =>
  (p.endsWith('.tsx') || p.endsWith('.ts')) &&
  !p.startsWith('node_modules/') && !p.startsWith('.next/');

export const codeFilesHandlers: Record<string, RpcHandler> = {
  'codeFiles.list': async (): Promise<CodeFileInfo[]> => {
    const out: CodeFileInfo[] = [];
    for (const path of projectFS.listFiles()) {
      if (!isCodeFilePath(path)) continue;
      out.push({
        id: path,
        path,
        name: path.split('/').pop() ?? path,
        content: projectFS.readFile(path) ?? '',
        // Export discovery deferred — needs babel parse pass.
        exports: [],
      });
    }
    return out;
  },

  'codeFiles.get': async (params): Promise<CodeFileInfo | null> => {
    const p = params as { id?: unknown };
    if (typeof p?.id !== 'string') throw new Error('codeFiles.get: id required');
    const content = projectFS.readFile(p.id);
    if (content == null) return null;
    return {
      id: p.id,
      path: p.id,
      name: p.id.split('/').pop() ?? p.id,
      content,
      exports: [],
    };
  },

  'codeFiles.setContent': async (params): Promise<void> => {
    const p = params as { id?: unknown; content?: unknown };
    if (typeof p?.id !== 'string' || typeof p?.content !== 'string') {
      throw new Error('codeFiles.setContent: id + content required');
    }
    modifyProjectFile(p.id, () => p.content as string);
    store.set(projectVersionAtom, (v) => v + 1);
  },

  'codeFiles.create': async (params): Promise<string> => {
    const p = params as { name?: unknown; content?: unknown };
    if (typeof p?.name !== 'string' || typeof p?.content !== 'string') {
      throw new Error('codeFiles.create: name + content required');
    }
    const path = p.name.includes('/') ? p.name : `code/${p.name}`;
    // Defensive auto-import: plugin authors (and AI generators) often
    // emit Code component bodies that reference `withResponsiveProps`,
    // `motion`, `useScroll`, hooks, etc. without including the matching
    // `import` lines. `syncImports` rebuilds the import block from
    // identifiers found in the body using the shared detector in
    // `import-detection.mjs`. Running it here means a plugin that
    // forgets the imports still produces a renderable file on first
    // write — and a plugin that includes them sees no change (the
    // detector preserves existing imports verbatim).
    const content = syncImports(p.content as string);
    trace.action('codeFiles.create', { path, autoImported: content !== p.content });
    projectFS.writeFile(path, content);
    store.set(projectVersionAtom, (v) => v + 1);
    return path;
  },

  'codeFiles.remove': async (params): Promise<void> => {
    const p = params as { id?: unknown };
    if (typeof p?.id !== 'string') throw new Error('codeFiles.remove: id required');
    projectFS.deleteFile(p.id);
    store.set(projectVersionAtom, (v) => v + 1);
  },

  'codeFiles.rename': async (params): Promise<void> => {
    const p = params as { id?: unknown; newName?: unknown };
    if (typeof p?.id !== 'string' || typeof p?.newName !== 'string') {
      throw new Error('codeFiles.rename: id + newName required');
    }
    const content = projectFS.readFile(p.id);
    if (content == null) throw new Error(`codeFiles.rename: file not found: ${p.id}`);
    const newPath = p.id.replace(/[^/]+$/, p.newName);
    projectFS.writeFile(newPath, content);
    projectFS.deleteFile(p.id);
    store.set(projectVersionAtom, (v) => v + 1);
  },

  /**
   * Open the code editor on the given file. Uses the same atom the
   * Library panel "Edit code" action writes to.
   */
  'codeFiles.navigateTo': async (params): Promise<void> => {
    const p = params as { id?: unknown };
    if (typeof p?.id !== 'string') throw new Error('codeFiles.navigateTo: id required');
    if (!projectFS.exists(p.id)) throw new Error(`codeFiles.navigateTo: file not found: ${p.id}`);
    store.set(componentEditorFileAtom, p.id);
  },

  // lint / typecheck / getVersions are typed in the SDK but require
  // TypeScript tooling integration + version-history infra that
  // Revyme doesn't have yet. The router default returns
  // NOT_IMPLEMENTED for these — explicit stubs would just be
  // boilerplate.
};
