// page-agent-client.ts — Browser-side agentic loop for the page-agent.
//
// The loop runs HERE, not in the node service, because the safe mutation layer
// (mutation queue + generators + parsed node cache) lives in the browser. The
// node service (/api/page-agent/turn) is a stateless Gemini relay — it does one
// model call and returns the parts. This client:
//
//   1. sends the tool schemas + turn-1 context summary + editor context
//   2. POSTs one turn to the relay
//   3. executes each function call LOCALLY via tool-executors (real mutations)
//   4. appends the model turn + the functionResponse turn to the conversation
//   5. repeats until the model returns text with no function calls
//
// The SYSTEM PROMPT is NOT built here — it lives in the node service
// (ai-generator, a private repo) so the prompt engineering stays out of this
// open-source builder. This client only sends the raw editor context
// (active file, selection, viewport) the service needs to assemble it.

import { getDefaultStore } from 'jotai';
import { activeFilePathAtom, isComponentFilePath } from '@/code/project/active-file-store';
import { selectedIdsAtom } from '@/code/stores/store';
import { interactingViewportIdAtom } from '@/code/stores/viewport-store';
import { trace } from '@/shared/debug-trace';
import { getCreditsState } from '@/code/stores/credits-store';
import { PAGE_AGENT_TOOLS, DESIGN_COMPONENT_TOOLS } from './tool-schemas';
import { executeTool } from './tool-executors';

const AI_SERVICE_URL = import.meta.env.VITE_AI_SERVICE_URL || 'http://localhost:8082';

/** Hard cap on agentic round-trips — bounds latency/cost and stops a
 *  stuck agent looping forever. Each turn is one Gemini call. With the
 *  system prompt pushing the agent to batch independent mutations, most
 *  jobs finish well under this; 40 is the runaway safety net. */
const MAX_TURNS = 40;

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PageAgentRequest {
  prompt: string;
  history?: { role: 'user' | 'assistant'; content: string }[];
}

export interface PageAgentResult {
  text: string;
  toolCallLog: { name: string; args: any; isError: boolean }[];
  usage: {
    inputTokens: number;
    outputTokens: number;
    model: string;
    durationMs: number;
    turns: number;
  };
}

export interface PageAgentCallbacks {
  /** Fired after each model turn so the UI can show live tool activity. */
  onTurn?: (info: { turn: number; toolCalls: { name: string; args: any }[] }) => void;
  onDone: (result: PageAgentResult) => void;
  onError: (error: string) => void;
}

// ─── Turn-1 context summary ─────────────────────────────────────────────────

/** Build the context block prepended to the user's first message — saves the
 *  AI 1-2 round-trips it would otherwise spend on list_files / get_node_tree. */
function buildContextSummary(): string {
  const tree = executeTool('get_node_tree', {});
  const files = executeTool('list_files', {});
  return `CURRENT PAGE TREE:\n${JSON.stringify(tree.response, null, 2)}\n\nPROJECT FILES:\n${JSON.stringify(files.response.files ?? [], null, 2)}`;
}

// ─── Agentic loop ───────────────────────────────────────────────────────────

export function runPageAgent(req: PageAgentRequest, callbacks: PageAgentCallbacks): AbortController {
  const controller = new AbortController();

  // Stable id for the WHOLE loop — sent every turn so the node service's
  // debug flow accumulates all turns into one debug_flows/ folder.
  const requestId = `page-agent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  (async () => {
    const startMs = Date.now();
    const store = getDefaultStore();
    const activeFilePath = store.get(activeFilePathAtom);
    const selectedNodeIds = store.get(selectedIdsAtom);
    const activeViewportId = store.get(interactingViewportIdAtom);

    // Component masters get the variant-layer tools on top of the node tools;
    // pages get just the node tools. The relay matches the system prompt to
    // the active file the same way.
    const tools = isComponentFilePath(activeFilePath) ? DESIGN_COMPONENT_TOOLS : PAGE_AGENT_TOOLS;

    // Running Gemini conversation. History first, then the user turn (with the
    // turn-1 context summary prepended so the agent starts informed).
    const contents: any[] = [];
    for (const msg of req.history ?? []) {
      contents.push({
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: msg.content }],
      });
    }
    contents.push({
      role: 'user',
      parts: [{ text: `${buildContextSummary()}\n\n---\n\nUSER REQUEST: ${req.prompt}` }],
    });

    const toolCallLog: PageAgentResult['toolCallLog'] = [];
    let totalInput = 0;
    let totalOutput = 0;
    let model = 'unknown';
    let finalText = '';
    let turnsRun = 0;
    // One-shot guard: a design component left with variants but no
    // connections gets a single nudge turn before the loop is allowed to end.
    let nudgedConnections = false;

    trace.action('page-agent:start', {
      requestId,
      prompt: req.prompt.slice(0, 80),
      activeFilePath,
      selectedNodeIds,
      historyLen: (req.history ?? []).length,
    });

    try {
      for (let turn = 0; turn < MAX_TURNS; turn++) {
        turnsRun = turn + 1;

        trace.action('page-agent:turn-request', { requestId, turn: turnsRun, contentsLen: contents.length });

        const res = await fetch(`${AI_SERVICE_URL}/api/page-agent/turn`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            requestId,
            prompt: req.prompt,
            contents,
            tools,
            // Raw editor context — the node service assembles the system
            // prompt from this. The prompt text itself never lives here.
            activeFilePath,
            selectedNodeIds,
            activeViewportId,
            // Workspace the AI cost is billed to — the service deducts
            // credits from this workspace's pool after each turn.
            workspaceId: getCreditsState()?.workspaceId,
          }),
          signal: controller.signal,
        });

        if (!res.ok) {
          const errBody = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
          throw new Error(errBody.error || `Request failed: ${res.status}`);
        }

        const data = await res.json();
        if (!data.success) throw new Error(data.error || 'page-agent turn failed');

        const parts: any[] = data.parts ?? [];
        totalInput += data.usage?.inputTokens ?? 0;
        totalOutput += data.usage?.outputTokens ?? 0;
        model = data.usage?.model ?? model;

        // Append the model turn so the next call sees what it just did.
        contents.push({ role: 'model', parts });

        const functionCalls = parts.filter(p => p.functionCall);
        const textParts = parts.filter(p => p.text);

        trace.action('page-agent:turn-response', {
          requestId,
          turn: turnsRun,
          functionCalls: functionCalls.map(p => p.functionCall.name),
          hasText: textParts.length > 0,
          inputTokens: data.usage?.inputTokens,
          outputTokens: data.usage?.outputTokens,
        });

        if (functionCalls.length === 0) {
          // A design component with multiple variants but ZERO connections
          // almost always means the agent forgot to wire the state machine —
          // every non-default variant is unreachable. Nudge it ONCE to add
          // the connections (or confirm the variants are responsive-only).
          if (isComponentFilePath(activeFilePath) && !nudgedConnections) {
            nudgedConnections = true;
            const gv = executeTool('get_variants', {}).response ?? {};
            const variantCount = Array.isArray(gv.variants) ? gv.variants.length : 0;
            const connCount = Array.isArray(gv.connections) ? gv.connections.length : 0;
            if (variantCount > 1 && connCount === 0) {
              trace.action('page-agent:nudge-missing-connections', { requestId, variantCount });
              contents.push({
                role: 'user',
                parts: [{ text: `This component has ${variantCount} variants and 0 connections. If it is INTERACTIVE — the user wants to MOVE between these states (a menu, toggle, open/close, tabs, accordion, steps) — you are NOT done: every target variant is unreachable without a connection, so call add_connection for each transition now, with the triggering element (button/icon) as the sourceNode. But if the variants are NOT meant to transition on interaction — responsive layouts, or independent style options the user picks per instance (button sizes, color themes) — then omitting connections is correct: reply that you are done.` }],
              });
              continue;
            }
          }
          // Final turn — no tool calls means the agent is done.
          for (const p of textParts) finalText += p.text;
          break;
        }

        callbacks.onTurn?.({
          turn: turnsRun,
          toolCalls: functionCalls.map(p => ({ name: p.functionCall.name, args: p.functionCall.args })),
        });

        // Execute each call LOCALLY against the real mutation layer.
        const responseParts: any[] = [];
        for (const part of functionCalls) {
          const { name, args } = part.functionCall;
          const result = executeTool(name, args ?? {});
          toolCallLog.push({ name, args: args ?? {}, isError: result.isError });
          responseParts.push({ functionResponse: { name, response: result.response } });
        }

        contents.push({ role: 'user', parts: responseParts });
      }

      const durationMs = Date.now() - startMs;
      trace.action('page-agent:done', {
        turns: turnsRun,
        toolCalls: toolCallLog.length,
        errors: toolCallLog.filter(t => t.isError).length,
        durationMs,
        tokens: totalInput + totalOutput,
      });

      callbacks.onDone({
        text: finalText || (toolCallLog.length > 0 ? 'Done.' : 'No changes.'),
        toolCallLog,
        usage: { inputTokens: totalInput, outputTokens: totalOutput, model, durationMs, turns: turnsRun },
      });
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        callbacks.onError('Stopped.');
      } else {
        trace.error('page-agent:error', err);
        callbacks.onError(err?.message ?? 'Page agent failed');
      }
    }
  })();

  return controller;
}
