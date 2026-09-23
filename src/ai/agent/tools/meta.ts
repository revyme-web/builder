// src/ai/agent/tools/meta.ts
//
// Meta tools — they coordinate the turn without touching ProjectFS. The
// `submit_plan` tool makes the model publish its intended work BEFORE the
// first mutation (plan-first, then act, mirroring the reference builder's plan mode). The
// runtime treats it as a normal tool_use; the editor store (agent-store.ts)
// intercepts the tool_call event on the UI side and surfaces the plan to the
// user. Execution does nothing beyond acking — the plan itself is the side
// effect.

import { z } from 'zod';
import type { AgentTool } from '@/ai/agent';

/**
 * Une étape de plan : une simple chaîne, OU un objet { content } — les modèles
 * expriment naturellement les étapes des deux façons (observé en E2E réel
 * 2026-08-15 : glm-4.7-flash envoyait [{content, status}] → zod rejetait le
 * plan entier alors que l'intention était claire). La tolérance EST le
 * correctif : l'agent-store normalise (extrait .content) pour l'affichage.
 */
const planStepSchema = z.union([
  z.string(),
  z.object({ content: z.string() }).passthrough(),
]);

export const submitPlanTool: AgentTool = {
  name: 'submit_plan',
  description:
    "Call this BEFORE any mutation when the task involves multiple steps or a new section (design plan). " +
    'Describe the overall plan in `plan` and the ordered `steps` you intend to execute (plain strings). ' +
    'The plan is shown to the user in the editor. Do not call it for a single precise edit.',
  inputSchema: {
    plan: z.string().describe('the overall design plan, shown to the user'),
    steps: z.array(planStepSchema).optional().describe('ordered steps to execute — each a plain string or {content: "..."}'),
  },
  category: 'meta',
  async execute() {
    // The plan was already surfaced by the editor when the tool_call event
    // arrived; nothing mutates ProjectFS, so ack and return.
    return {
      content: [{ type: 'text', text: JSON.stringify({ received: true }) }],
    };
  },
};