// surface-state.ts — read the live editor into the pure surface model.
//
// `surface.ts` decides; this file only FETCHES, which is why it is separate:
// the rules are tested with plain values, and everything that touches atoms or
// ProjectFS lives here. Never throws — a fact that cannot be read is simply
// absent, and the surface is still named.

import { getDefaultStore } from 'jotai';
import { activeFilePathAtom } from '@/code/project/active-file-store';
import { componentEditorFileAtom, componentEditorPropsAtom } from '@/code/stores/component-editor-store';
import {
  cmsEditorOpenAtom, cmsEditorCollectionAtom, cmsEditorExpandedItemAtom, cmsEditorFocusedFieldAtom,
} from '@/code/stores/cms-editor-store';
import { projectFS } from '@/code/project/project-fs';
import { pluginEditorFileAtom } from '@/editor/plugin-editor/plugin-editor-store';
import { parseIconSetConfig } from '@/code/icons/icon-set-config';
import { parseIconSetDisplayName } from '@/code/icons/icon-set-template';
import { parseComponentControlsMeta } from '@/code/components/controls-parser';
import { getCollectionSchema, getCollectionData } from '@/code/project/cms-ops';
import { trace } from '@/shared/debug-trace';
import {
  resolveAgentSurface, type AgentSurface, type CodeComponentFacts, type CmsCollectionFacts, type PluginFacts, type IconSetFacts,
} from './surface';

export function readAgentSurface(): AgentSurface {
  const store = getDefaultStore();
  return resolveAgentSurface({
    activeFilePath: store.get(activeFilePathAtom) ?? null,
    componentEditorFile: store.get(componentEditorFileAtom),
    cmsOpen: store.get(cmsEditorOpenAtom),
    cmsCollection: store.get(cmsEditorCollectionAtom),
    cmsExpandedItem: store.get(cmsEditorExpandedItemAtom),
    cmsFocusedField: store.get(cmsEditorFocusedFieldAtom),
    pluginEditorFile: store.get(pluginEditorFileAtom),
  });
}

export function readPluginFacts(filePath: string): PluginFacts | null {
  try {
    const code = projectFS.readFile(filePath);
    if (code == null) return null;
    return { name: filePath.replace(/^.*\//, '').replace(/\.tsx?$/, ''), lines: code.split('\n').length };
  } catch (err) {
    trace.error('agent-surface:plugin-facts-failed', err);
    return null;
  }
}

export function readIconSetFacts(filePath: string): IconSetFacts | null {
  try {
    const code = projectFS.readFile(filePath);
    if (code == null) return null;
    return {
      name: parseIconSetDisplayName(code) ?? filePath.replace(/^.*\//, '').replace(/\.tsx?$/, ''),
      icons: parseIconSetConfig(code).map((c) => c.label || c.name),
    };
  } catch (err) {
    trace.error('agent-surface:icon-set-facts-failed', err);
    return null;
  }
}

export function readCodeComponentFacts(filePath: string): CodeComponentFacts | null {
  try {
    const code = projectFS.readFile(filePath);
    if (!code) return null;
    const meta = parseComponentControlsMeta(code);
    const base = filePath.replace(/^.*\//, '').replace(/\.tsx?$/, '');
    return {
      label: meta?.label || base,
      lines: code.split('\n').length,
      controls: Object.entries(meta?.controls ?? {}).map(([key, def]) => ({ key, type: String(def?.type ?? 'unknown'), label: def?.label })),
      previewProps: getDefaultStore().get(componentEditorPropsAtom) ?? {},
    };
  } catch (err) {
    trace.error('agent-surface:code-component-facts-failed', err);
    return null;
  }
}

export function readCmsFacts(surface: Extract<AgentSurface, { kind: 'cms' }>): CmsCollectionFacts | null {
  if (!surface.collection) return null;
  try {
    const schema = getCollectionSchema(surface.collection);
    if (!schema) return null;
    const items = getCollectionData(surface.collection);
    const open = surface.expandedItemId ? items.find((it) => it._id === surface.expandedItemId) : null;
    const titleField = schema.fields.find((f) => f.type === 'text') ?? schema.fields[0];
    const focused = surface.focusedFieldId ? schema.fields.find((f) => f.id === surface.focusedFieldId) : null;
    return {
      name: schema.name,
      slug: schema.slug,
      fields: schema.fields.map((f) => ({ id: f.id, name: f.name, type: f.type })),
      itemCount: items.length,
      expandedItemTitle: open && titleField ? String((open as Record<string, unknown>)[titleField.id] ?? open._id) : null,
      focusedFieldName: focused?.name ?? null,
    };
  } catch (err) {
    trace.error('agent-surface:cms-facts-failed', err);
    return null;
  }
}
