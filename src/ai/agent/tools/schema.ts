import { z } from 'zod';
import type { AgentTool, ProviderTool } from '@/ai/agent';

/** Convertit un AgentTool (zod raw shape) en ProviderTool (JSON Schema provider-ready). */
export function toProviderTool(tool: AgentTool): ProviderTool {
  const jsonSchema = z.toJSONSchema(z.object(tool.inputSchema)) as Record<string, unknown>;
  delete (jsonSchema as { $schema?: unknown }).$schema; // ni Anthropic ni OpenAI ne veulent ce marqueur
  return { name: tool.name, description: tool.description, input_schema: jsonSchema };
}

/** Convertit une liste d'outils vers les schémas provider. */
export function toProviderTools(tools: AgentTool[]): ProviderTool[] {
  return tools.map(toProviderTool);
}

/** Matériau outils pour la config du host (scripts/revyme-host — LECTURE
 *  SEULE). Le host traduit chaque propriété JSON Schema en expression zod ;
 *  son mapping `type:'object'` → `tool.schema.record(...)` est un idiome
 *  zod v3 : sous zod v4 (runtime du CLI), un seul argument est le schéma de
 *  CLÉ, et le chargement du plugin plante (« Unexpected server error »).
 *  Les propriétés objet sont donc transmises SANS `type` (le `description`
 *  reste) : le host les rend `any()`, la validation réelle demeure côté SPA
 *  (le pont interne tool-call valide avec les vrais schémas zod). */
export function toHostToolDescriptors(tools: AgentTool[]): ProviderTool[] {
  return tools.map((agentTool) => {
    const provider = toProviderTool(agentTool);
    const props = (provider.input_schema.properties ?? {}) as Record<string, unknown>;
    for (const key of Object.keys(props)) {
      const prop = props[key] as Record<string, unknown> | undefined;
      if (prop && typeof prop === 'object' && prop.type === 'object') {
        const { type: _type, ...rest } = prop;
        props[key] = rest;
      }
    }
    return provider;
  });
}
