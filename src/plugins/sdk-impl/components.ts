// plugins/sdk-impl/components.ts — components.* namespace.

import { getDefaultStore } from 'jotai';
import { projectFS, projectVersionAtom } from '@/code/project/project-fs';
import { activeFilePathAtom } from '@/code/project/active-file-store';
import { nodesAtom } from '@/code/stores/store';
import { buildComponentRegistry } from '@/code/components/component-registry';
import { generateInternalName } from '@/code/components/component-ops';
import { modifyProjectFile } from '@/code/project/modify-file';
import { addNodeInCode, type AddNodeDef } from '@/code/generation/generator-crud';
import { makeNodeId } from './_id-gen';
import type { ComponentInfo } from '@revyme/plugin-sdk';
import type { RpcHandler } from '../plugin-types';

const store = getDefaultStore();

interface RegistryComponent {
  filePath: string;
  name: string;
  isCodeComponent?: boolean;
}

function toComponentInfo(c: RegistryComponent): ComponentInfo {
  return {
    path: c.filePath,
    name: c.name,
    internalName: c.filePath.replace('components/', '').replace('.tsx', ''),
    isCode: c.isCodeComponent ?? false,
  };
}

export const componentsHandlers: Record<string, RpcHandler> = {
  'components.list': async (): Promise<ComponentInfo[]> => {
    const reg = buildComponentRegistry(projectFS);
    return Array.from(reg.values()).map((c) => toComponentInfo(c as RegistryComponent));
  },

  'components.get': async (params): Promise<ComponentInfo | null> => {
    const p = params as { path?: unknown };
    if (typeof p?.path !== 'string') throw new Error('components.get: path required');
    const reg = buildComponentRegistry(projectFS);
    const c = reg.get(p.path);
    return c ? toComponentInfo(c as RegistryComponent) : null;
  },

  'components.createDesign': async (params): Promise<string> => {
    const p = params as { name?: unknown };
    if (typeof p?.name !== 'string' || !p.name.trim()) {
      throw new Error('components.createDesign: name required');
    }
    const internalName = generateInternalName();
    const filePath = `components/${internalName}.tsx`;
    const tmpl = `'use client';\n\nimport React from 'react';\nimport { motion, LayoutGroup } from 'framer-motion';\nimport { withResponsiveProps } from '@revyme/runtime';\n\n/** @name "${p.name}" */\nconst variantConfig = [{ name: 'default', label: '${p.name}', x: 0, y: 0, isPrimary: true }];\n\nfunction ${internalName}({ style }: { style?: React.CSSProperties }) {\n  return (\n    <LayoutGroup>\n      <motion.div layout={true} data-id="${internalName.toLowerCase()}-root" data-name="${p.name}" style={{\n        position: 'relative',\n        width: '300px',\n        height: '300px',\n        backgroundColor: '#ffffff',\n        ...style,\n      }} />\n    </LayoutGroup>\n  );\n}\n\nexport default withResponsiveProps(${internalName});\n`;
    projectFS.writeFile(filePath, tmpl);
    store.set(projectVersionAtom, (v) => v + 1);
    return filePath;
  },

  /**
   * Drop a component instance onto the active page. The url can be
   * a local component path (`components/Hero.tsx`) or a CDN URL
   * (`https://assets.revyme.app/components/Hero@hash.js`); we
   * derive the JSX tag name from the path.
   *
   * Generates a fresh data-id and inserts as the last child of the
   * active page's root. Plugin authors can follow up with
   * `canvas.setAttributes` to position / style the instance.
   */
  'components.addInstance': async (params): Promise<string> => {
    const p = params as {
      url?: unknown;
      attributes?: { styles?: Record<string, string>; name?: string };
    };
    if (typeof p?.url !== 'string') throw new Error('components.addInstance: url required');
    // Parse the JSX tag name out of the path/URL.
    // Local: components/Hero.tsx → Hero
    // CDN:   .../components/Hero@<hash>.js → Hero
    const slugMatch = p.url.match(/components\/([A-Za-z][A-Za-z0-9_]*)/);
    if (!slugMatch) throw new Error(`components.addInstance: cannot derive component name from url: ${p.url}`);
    const tag = slugMatch[1];
    // Find the active page's root.
    const nodes = store.get(nodesAtom);
    let rootId: string | null = null;
    for (const [id, node] of nodes) {
      if (!node.parentId) { rootId = id; break; }
    }
    if (!rootId) throw new Error('components.addInstance: active page has no root');
    const id = makeNodeId(tag.toLowerCase());
    const styles: Record<string, string> = { ...(p.attributes?.styles ?? { position: 'absolute', left: '0px', top: '0px' }) };
    // Flex/grid ROOT → the appended instance must carry an explicit sequential
    // `order` (quoted string) + `position: relative`, or it snaps to the front
    // of the order:0 group and the builder's drag-to-reorder can't track it
    // (the FLEX_CHILD_MISSING_ORDER invariant). Order = current child count
    // (append at the end).
    const parentDisplay = nodes.get(rootId)?.styles?.display;
    if (parentDisplay === 'flex' || parentDisplay === 'inline-flex' || parentDisplay === 'grid' || parentDisplay === 'inline-grid') {
      if (styles.order == null) {
        styles.order = String([...nodes.values()].filter((n) => n.parentId === rootId).length);
      }
      if (styles.position == null || styles.position === 'absolute') styles.position = 'relative';
    }
    const def: AddNodeDef = {
      id,
      type: tag,
      styles,
      // Prefer the caller's friendly display name (e.g. "Gradient") over the
      // internal component tag ("Gradientab12") for the layers panel / data-name.
      name: p.attributes?.name ?? tag,
    };
    modifyProjectFile(store.get(activeFilePathAtom), (code) => addNodeInCode(code, rootId as string, def));
    return id;
  },

  /**
   * Drop the component's INNER LAYERS as a detached group (no link
   * to master). Requires expanding the component's JSX tree which is
   * non-trivial — keep stubbed until a Pass 3 detach utility lands.
   */
  'components.addDetachedComponentLayers': async () => {
    throw new Error(
      'NOT_IMPLEMENTED:components.addDetachedComponentLayers (needs component-tree expansion, Pass 3+)',
    );
  },

  'components.createCode': async (params): Promise<string> => {
    const p = params as { name?: unknown };
    if (typeof p?.name !== 'string' || !p.name.trim()) {
      throw new Error('components.createCode: name required');
    }
    const internalName = generateInternalName();
    const filePath = `components/${internalName}.tsx`;
    const tmpl = `'use client';\n\n/** @label "${p.name}" */\n/** @controls {\n  "color": { "type": "color", "label": "Color", "default": "#3b82f6" }\n} */\n\nimport { withResponsiveProps } from '@revyme/runtime';\n\nfunction ${internalName}({ color = '#3b82f6', ...props }: { color?: string; [key: string]: any }) {\n  return <div {...props} style={{ ...((props as any).style || {}), backgroundColor: color, width: '100%', height: '100%' }} />;\n}\n\nexport default withResponsiveProps(${internalName});\n`;
    projectFS.writeFile(filePath, tmpl);
    store.set(projectVersionAtom, (v) => v + 1);
    return filePath;
  },
};
