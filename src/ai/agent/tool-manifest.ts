// tool-manifest.ts — the agent's tool surface, serialized for a remote brain.
//
// The BUILDER owns the tools: their schemas, their descriptions and the code
// that executes them against live ProjectFS / canvas state. The turn loop that
// decides WHICH tool to call runs in the ai-generator service, in another
// process, so it needs a transport-safe description of that surface — JSON
// Schema, not zod objects.
//
// One source of truth on purpose: the schema a tool validates its input with
// IS the schema the model is shown. Hand-writing a second copy for the prompt
// is how a tool ends up advertising a parameter it rejects.

import { z } from 'zod';
import { ALL_TOOLS } from './tools';
import { trace } from '@/shared/debug-trace';

export interface ToolManifestEntry {
  name: string;
  description: string;
  category: string;
  /** JSON Schema (draft 2020-12) for the tool's arguments. */
  inputSchema: Record<string, unknown>;
}

/**
 * Serialize every registered tool. A tool whose schema cannot be converted is
 * DROPPED with a trace rather than shipped half-described — the model would
 * otherwise be offered a tool it can never call correctly, and the failure
 * would surface as an unexplained validation bounce mid-turn.
 */
export function buildToolManifest(): ToolManifestEntry[] {
  const out: ToolManifestEntry[] = [];
  for (const tool of ALL_TOOLS) {
    try {
      const schema = z.toJSONSchema(z.object(tool.inputSchema), { io: 'input' }) as Record<string, unknown>;
      out.push({
        name: tool.name,
        description: tool.description,
        category: tool.category,
        inputSchema: schema,
      });
    } catch (err) {
      trace.error('tool-manifest:schema-failed', { tool: tool.name, error: String(err) });
    }
  }
  trace.action('tool-manifest:built', { tools: out.length, of: ALL_TOOLS.length });
  return out;
}

/** Look up a registered tool by name. */
export function findTool(name: string) {
  return ALL_TOOLS.find((t) => t.name === name) ?? null;
}
