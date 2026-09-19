// src/ai/agent/tools/coerce.test.ts

import { describe, it, expect } from 'vitest';
import { coerceRecord, normalizeBatchOp, coerceBatchOps } from './coerce';

describe('coerceRecord — réparation des records styles/attrs', () => {
  it('laisse un record propre inchangé', () => {
    expect(coerceRecord({ color: 'red', padding: '64px' })).toEqual({ color: 'red', padding: '64px' });
  });

  it('parse un JSON string sérialisé (le mode d’échec réel des modèles flash)', () => {
    const raw = '{"display": "flex", "padding": "64px"}';
    expect(coerceRecord(raw)).toEqual({ display: 'flex', padding: '64px' });
  });

  it('convertit les valeurs numériques en chaînes CSS-safe', () => {
    expect(coerceRecord({ padding: 64, fontSize: 48, opacity: 0.5 })).toEqual({
      padding: '64',
      fontSize: '48',
      opacity: '0.5',
    });
  });

  it('retire null/undefined et les objets imbriqués, ne throw jamais', () => {
    expect(coerceRecord({ a: null, b: undefined, c: { nested: 1 }, d: [1], e: 'ok' })).toEqual({ e: 'ok' });
  });

  it('retombe sur {} pour toute forme non réparable', () => {
    expect(coerceRecord(42)).toEqual({});
    expect(coerceRecord('not-json{')).toEqual({});
    expect(coerceRecord(null)).toEqual({});
    expect(coerceRecord(undefined)).toEqual({});
  });
});

describe('normalizeBatchOp — formes d’opérations tolérées', () => {
  it('laisse la forme canonique {tool, args, ref_id} inchangée', () => {
    expect(normalizeBatchOp({ tool: 'add_node', args: { parent_id: 'root' }, ref_id: 'a' })).toEqual({
      tool: 'add_node',
      args: { parent_id: 'root' },
      ref_id: 'a',
    });
  });

  it('normalise {op: ...} + args aplatis', () => {
    expect(
      normalizeBatchOp({
        op: 'add_node',
        parent_id: 'root',
        tag: 'section',
        styles: { padding: 64 },
        attrs: '{"data-id":"x"}',
      }),
    ).toEqual({
      tool: 'add_node',
      args: { parent_id: 'root', tag: 'section', styles: { padding: '64' }, attrs: { 'data-id': 'x' } },
    });
  });

  it('normalise {operation: ..., args}', () => {
    expect(normalizeBatchOp({ operation: 'set_styles', args: { node_id: 'a', styles: '{"color":"red"}' } })).toEqual({
      tool: 'set_styles',
      args: { node_id: 'a', styles: { color: 'red' } },
    });
  });

  it('normalise {name: \'<tool>\', args} (le nom du tool comme clé name)', () => {
    expect(normalizeBatchOp({ name: 'add_node', args: { parent_id: 'root', tag: 'section' } })).toEqual({
      tool: 'add_node',
      args: { parent_id: 'root', tag: 'section' },
    });
  });

  it('normalise {operation: \'<tool>\', ...plat} (args aplatis réparés par restOf)', () => {
    expect(
      normalizeBatchOp({
        operation: 'add_node',
        parent_id: 'root',
        tag: 'section',
        styles: { padding: 64 },
      }),
    ).toEqual({
      tool: 'add_node',
      args: { parent_id: 'root', tag: 'section', styles: { padding: '64' } },
    });
  });

  it('RÉGRESSION : {operation: ..., args} existant reste sémantiquement inchangé', () => {
    expect(normalizeBatchOp({ operation: 'add_node', args: { parent_id: 'root' } })).toEqual({
      tool: 'add_node',
      args: { parent_id: 'root' },
    });
  });

  it('RÉGRESSION : forme plate {name, parent_id, tag} (display-name d\'un add_node plat) reste add_node', () => {
    expect(normalizeBatchOp({ name: 'Hero', parent_id: 'x', tag: 'section' })).toEqual({
      tool: 'add_node',
      args: { name: 'Hero', parent_id: 'x', tag: 'section' },
    });
  });

  it('normalise {add_node: {...}} (le nom du tool comme clé unique)', () => {
    expect(normalizeBatchOp({ add_node: { parent_id: 'root', tag: 'div' } })).toEqual({
      tool: 'add_node',
      args: { parent_id: 'root', tag: 'div' },
    });
  });

  it('normalise une forme aplatie avec tag → add_node (définition de nœud)', () => {
    expect(
      normalizeBatchOp({ tag: 'section', parent_id: 'root', styles: { padding: 64 }, attrs: { 'data-id': 'hero' } }),
    ).toEqual({
      tool: 'add_node',
      args: { tag: 'section', parent_id: 'root', styles: { padding: '64' }, attrs: { 'data-id': 'hero' } },
    });
  });

  it('normalise une forme aplatie avec node_id → set_styles/set_attr/set_text selon les champs', () => {
    expect(normalizeBatchOp({ node_id: 'a', styles: { color: 'red' } })).toEqual({
      tool: 'set_styles',
      args: { node_id: 'a', styles: { color: 'red' } },
    });
    expect(normalizeBatchOp({ node_id: 'a', attrs: { alt: 'x' } })).toEqual({
      tool: 'set_attr',
      args: { node_id: 'a', attrs: { alt: 'x' } },
    });
    expect(normalizeBatchOp({ node_id: 'a', text: 'hi' })).toEqual({
      tool: 'set_text',
      args: { node_id: 'a', text: 'hi' },
    });
  });

  it('laisse une forme non inférable telle quelle (zod la rejettera)', () => {
    const op = { mystery: 1 };
    expect(normalizeBatchOp(op)).toBe(op);
  });
});

describe('coerceBatchOps', () => {
  it('applique la normalisation à chaque élément d’un tableau', () => {
    expect(coerceBatchOps([{ op: 'add_node', parent_id: 'root' }, { set_text: { node_id: 'x', text: 'hi' } }])).toEqual([
      { tool: 'add_node', args: { parent_id: 'root' } },
      { tool: 'set_text', args: { node_id: 'x', text: 'hi' } },
    ]);
  });

  it('laisse un non-tableau tel quel', () => {
    expect(coerceBatchOps('nope')).toBe('nope');
  });
});
