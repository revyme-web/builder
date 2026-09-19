import type { AgentTool, ToolCategory } from '@/ai/agent';

/** Filtre les outils par catégorie. */
export function getToolsByCategory(tools: AgentTool[], categories?: ToolCategory[]): AgentTool[] {
  if (!categories || categories.length === 0) return tools;
  return tools.filter((t) => categories.includes(t.category));
}

/** Map<name, tool> pour le dispatch runtime. */
export function buildToolMap(tools: AgentTool[]): Map<string, AgentTool> {
  const map = new Map<string, AgentTool>();
  for (const t of tools) {
    if (map.has(t.name)) throw new Error(`Duplicate tool name: "${t.name}".`);
    map.set(t.name, t);
  }
  return map;
}

/** Vérifie qu'un ensemble d'outils a des noms uniques (throw sinon). */
export function assertUniqueToolNames(tools: AgentTool[]): void {
  buildToolMap(tools); // reutilise la vérif
}
