// src/ai/agent/tools/meta.test.ts

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { submitPlanTool } from './meta';

describe('submitPlanTool', () => {
  it('accepte des steps en chaînes (forme canonique)', () => {
    const parsed = z.object(submitPlanTool.inputSchema).parse({
      plan: 'Build a section',
      steps: ['Add container', 'Add heading'],
    });
    expect(parsed.steps).toEqual(['Add container', 'Add heading']);
  });

  it('tolère des steps en objets {content} (forme naturelle des modèles)', () => {
    // E2E réel 2026-08-15 : glm-4.7-flash envoyait [{content, status}] →
    // l'ancien z.array(z.string()) rejetait le plan entier.
    const parsed = z.object(submitPlanTool.inputSchema).parse({
      plan: 'Build a section',
      steps: [
        { content: 'Add container', status: 'pending' },
        { content: 'Add heading' },
        'plain string still works',
      ],
    });
    expect(parsed.steps).toHaveLength(3);
  });

  it('n’exécute rien et accuse réception', async () => {
    const result = await submitPlanTool.execute(
      { plan: 'x', steps: ['a'] },
      { ensureCheckpoint: () => {}, vpWidth: 1440, signal: new AbortController().signal },
    );
    expect(result.isError).toBeUndefined();
    expect(JSON.parse((result.content[0] as any).text)).toEqual({ received: true });
  });
});
