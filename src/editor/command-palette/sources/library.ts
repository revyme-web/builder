// sources/library.ts — Local project assets: design components, code
// components, icon sets, vectors, templates.
//
// Everything here except templates activates as an INSERT: the row builds
// an instance clipboard and hands it to the shared paste-rule engine, so
// a palette insert lands exactly where a Library-panel drag would. The
// palette never constructs nodes itself — that divergence is what made
// the old builder's 1,100-line action file drift from drag behaviour.
//
// Templates are route-group layout files, not instantiable, so they
// switch the active file instead.

import { ComponentClusterIcon } from '@/shared/icons';
import { projectFS } from '@/code/project/project-fs';
import {
  isComponentFilePath,
  isCodeComponentPath,
  isIconSetFilePath,
  getFileDisplayName,
} from '@/code/project/active-file-store';
import { listTemplates } from '@/code/project/template-ops';
import type { SearchableItem } from '../search-types';
import type { SearchSource } from './types';

/** No dedicated helper today — match the path convention the SDK's
 *  vectors namespace and the LibraryPanel both use: `vectors/<name>.tsx`. */
function listAllVectorFiles(): string[] {
  return projectFS.listFiles('vectors/').filter((f) => f.endsWith('.tsx'));
}

/** Internal name of a master file — the same string `useComponentDrag`
 *  uses as the JSX tag for a dropped instance. Mirrors how Library panel
 *  rows derive their drag id, which is why insert parity holds. */
function fileToInternalName(filePath: string): string {
  return filePath
    .replace(/^(components|icons|vectors)\//, '')
    .replace(/\.tsx$/, '');
}

export const librarySource: SearchSource = () => {
  const items: SearchableItem[] = [];

  // Components — design and code components both live under `components/`.
  // They're split into distinct subcategories because they behave
  // differently once on canvas (code components own their own render and
  // can't be edited on the canvas), and users think of them as separate
  // things when searching.
  const componentFiles = projectFS.listFiles('components/').filter((f) => f.endsWith('.tsx'));
  for (const file of componentFiles) {
    if (!isComponentFilePath(file)) continue;
    const name = getFileDisplayName(file);
    const isCode = isCodeComponentPath(file);
    items.push({
      id: `lib:component:${file}`,
      name,
      category: 'library',
      subcategory: isCode ? 'Code Component' : 'Component',
      keywords: isCode
        ? [name.toLowerCase(), 'code', 'component', 'react', 'custom']
        : [name.toLowerCase(), 'component', 'master', 'reusable'],
      icon: ComponentClusterIcon,
      action: { type: 'insert-library-item', filePath: file, elementType: fileToInternalName(file) },
    });
  }

  // Icon sets — `icons/<name>.tsx`
  const iconFiles = projectFS.listFiles('icons/').filter((f) => f.endsWith('.tsx'));
  for (const file of iconFiles) {
    if (!isIconSetFilePath(file)) continue;
    const name = getFileDisplayName(file);
    items.push({
      id: `lib:icon-set:${file}`,
      name,
      category: 'library',
      subcategory: 'Icon Set',
      keywords: [name.toLowerCase(), 'icon', 'icons', 'set', 'vector'],
      action: { type: 'insert-library-item', filePath: file, elementType: fileToInternalName(file) },
    });
  }

  // Vectors — `vectors/<name>.tsx`
  for (const file of listAllVectorFiles()) {
    const name = getFileDisplayName(file);
    items.push({
      id: `lib:vector:${file}`,
      name,
      category: 'library',
      subcategory: 'Vector',
      keywords: [name.toLowerCase(), 'vector', 'svg', 'illustration', 'graphic'],
      action: { type: 'insert-library-item', filePath: file, elementType: fileToInternalName(file) },
    });
  }

  // Templates — layout files, not instantiable. Switching the active
  // file is the right intent.
  for (const t of listTemplates()) {
    items.push({
      id: `lib:template:${t.clientPath}`,
      name: t.name,
      category: 'library',
      subcategory: 'Template',
      keywords: [t.name.toLowerCase(), 'template', 'layout', 'route group'],
      action: { type: 'switch-active-file', filePath: t.clientPath },
    });
  }

  return items;
};
