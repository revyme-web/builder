// src/ai/agent/tools/contract-guidance.test.ts
//
// Contract guidance: the sensitive input fields carry .describe() explainers
// (R2) and every description exposes the invariants the code is silent about
// (status/checked, silent no-ops, reserved attrs, id charset). Zod 4 stores
// the string at `schema.description` (verified — `_def.description` /
// `_description` are gone in zod 4).

import { describe, it, expect } from 'vitest';
import {
  setStylesTool,
  setTextTool,
  setRichTextTool,
  setAttrTool,
  changeTagTool,
} from './semantic-property';
import {
  addNodeTool,
  deleteNodeTool,
  moveNodeTool,
  reorderNodeTool,
  duplicateNodeTool,
  addComponentInstanceTool,
  setComponentPropTool,
} from './semantic-structure';
import { getLayoutTool, getVisualsTool, auditDesignTool, getCompositionTool } from './read';
import { batchTool } from './batch';


function describeOf(schema: unknown): string {
  return (schema as { description?: string }).description ?? '';
}

describe('tool contract guidance', () => {
  it('describe les champs sensibles de set_styles (styles camelCase, viewport px)', () => {
    expect(describeOf(setStylesTool.inputSchema.styles)).toContain('camelCase');
    expect(describeOf(setStylesTool.inputSchema.viewport)).toContain('px');
  });

  it('set_attr annonce les attributs d\'identité réservés', () => {
    expect(setAttrTool.description).toContain('reserved');
    expect(setAttrTool.description).toContain('data-id');
  });

  it('set_rich_text annonce son caractère destructif', () => {
    expect(setRichTextTool.description).toContain('REPLACES');
  });

  it('delete/move/reorder signalent le no-op silencieux sur id inconnu', () => {
    for (const tool of [deleteNodeTool, moveNodeTool, reorderNodeTool]) {
      expect(tool.description, `${tool.name} doit signaler le no-op`).toContain('silent no-op');
    }
  });

  it('duplicate_node annonce des data-ids frais générés', () => {
    expect(duplicateNodeTool.description).toContain('fresh auto-generated');
  });

  it('set_component_prop enseigne le value en string littéral', () => {
    expect(setComponentPropTool.description).toContain('string literal');
  });

  it('add_node.id donne un exemple de data-id et son charset', () => {
    expect(describeOf(addNodeTool.inputSchema.id)).toContain('hero-section');
    expect(describeOf(addNodeTool.inputSchema.id)).toContain('hyphens');
  });

  it('les 4 outils d\'observation annoncent le status de leur sortie', () => {
    const tools = [getLayoutTool, getVisualsTool, auditDesignTool, getCompositionTool];
    for (const tool of tools) {
      expect(tool.description, `${tool.name} doit annoncer le status`).toContain('status');
    }
  });

  it('batch annonce la forme canonique {tool, args} avec un exemple complet', () => {
    const desc = describeOf(batchTool.inputSchema.operations);
    expect(desc).toContain('{tool, args}');
    expect(desc).toContain('add_node');
  });
});