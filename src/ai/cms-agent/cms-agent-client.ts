// cms-agent-client.ts — Browser-side agentic loop for the CMS agent.
//
// Mirrors page-agent-client.ts: the loop runs HERE because the cms-ops
// mutation layer lives in the browser. /api/page-agent/turn is a stateless
// Gemini relay — it does one model call and returns the parts. This client
// sends `cmsCollection` instead of `activeFilePath`; the relay branches to
// the CMS system prompt on that field. Tool calls execute locally via
// cms-tool-executors (real cms-ops writes).

import { getDefaultStore } from 'jotai';
import { cmsEditorCollectionAtom } from '@/code/stores/cms-editor-store';
import { getCreditsState } from '@/code/stores/credits-store';
import { trace } from '@/shared/debug-trace';
import { CMS_AGENT_TOOLS } from './cms-tool-schemas';
import { executeCmsTool } from './cms-tool-executors';
import type {
  PageAgentRequest, PageAgentResult, PageAgentCallbacks,
} from '../page-agent/page-agent-client';

const AI_SERVICE_URL = import.meta.env.VITE_AI_SERVICE_URL || 'http://localhost:8082';

/** Hard cap on agentic round-trips — bounds latency/cost. Building a
 *  10-item collection with a few fields should finish well under this. */
const MAX_TURNS = 40;

// ─── Turn-1 context summary ─────────────────────────────────────────────────

/** Context block prepended to the first user message — saves the agent the
 *  round-trips it would spend on list_collections / get_collection.
 *
 *  When the user has a collection open, this panel is SCOPED to that one
 *  collection (the header literally reads "Vibe – <Collection Name>") and
 *  the user has no UI affordance to retarget it. The block ends with a
 *  hard rule so the agent never wanders off to make a new collection
 *  instead of editing the active one. `create_collection` is also stripped
 *  from the tool list in that case (see runCmsAgent), so this rule is
 *  belt-and-suspenders. */
function buildContextSummary(activeSlug: string | null): string {
  const list = executeCmsTool('list_collections', {}).response;
  let summary = `ALL COLLECTIONS:\n${JSON.stringify(list.collections ?? [], null, 2)}`;
  if (activeSlug) {
    const active = executeCmsTool('get_collection', { collection: activeSlug }).response;
    if (!('error' in active)) {
      summary += `\n\nACTIVE COLLECTION — the one the user is currently looking at:\n${JSON.stringify(active, null, 2)}`;
    }
    summary += `\n\nSTRICT RULE: This chat is locked to the ACTIVE COLLECTION ("${activeSlug}"). You MUST only edit that collection. Do NOT create new collections, switch collections, or operate on any other slug. If the user asks for something that would need a different collection, refuse with: "I can only edit the active collection from this panel. Open the CMS root to create or switch collections."`;
  }
  return summary;
}

// ─── Agentic loop ───────────────────────────────────────────────────────────

export function runCmsAgent(req: PageAgentRequest, callbacks: PageAgentCallbacks): AbortController {
  const controller = new AbortController();

  // Stable id for the WHOLE loop — sent every turn so the relay's debug
  // flow accumulates all turns into one debug_flows/ folder.
  const requestId = `cms-agent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  (async () => {
    const startMs = Date.now();
    const store = getDefaultStore();
    const activeCollection = store.get(cmsEditorCollectionAtom);

    // Running Gemini conversation. History first, then the user turn (with
    // the turn-1 context summary prepended so the agent starts informed).
    const contents: any[] = [];
    for (const msg of req.history ?? []) {
      contents.push({
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: msg.content }],
      });
    }
    contents.push({
      role: 'user',
      parts: [{ text: `${buildContextSummary(activeCollection)}\n\n---\n\nUSER REQUEST: ${req.prompt}` }],
    });

    const toolCallLog: PageAgentResult['toolCallLog'] = [];
    let totalInput = 0;
    let totalOutput = 0;
    let model = 'unknown';
    let finalText = '';
    let turnsRun = 0;

    // When the chat is scoped to one collection, physically remove
    // `create_collection` from the tool list — the model can't call what
    // it can't see, eliminating any chance of accidental new collections.
    const tools = activeCollection
      ? CMS_AGENT_TOOLS.filter(t => t.name !== 'create_collection')
      : CMS_AGENT_TOOLS;

    trace.action('cms-agent:start', {
      requestId,
      prompt: req.prompt.slice(0, 80),
      activeCollection,
      historyLen: (req.history ?? []).length,
      toolsCount: tools.length,
      scopedToActive: !!activeCollection,
    });

    try {
      for (let turn = 0; turn < MAX_TURNS; turn++) {
        turnsRun = turn + 1;

        trace.action('cms-agent:turn-request', { requestId, turn: turnsRun, contentsLen: contents.length });

        const res = await fetch(`${AI_SERVICE_URL}/api/page-agent/turn`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            requestId,
            prompt: req.prompt,
            contents,
            tools,
            // `cmsCollection` is what tells the relay to build the CMS
            // system prompt instead of the page-agent one.
            cmsCollection: activeCollection ?? '',
            workspaceId: getCreditsState()?.workspaceId,
          }),
          signal: controller.signal,
        });

        if (!res.ok) {
          const errBody = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
          throw new Error(errBody.error || `Request failed: ${res.status}`);
        }

        const data = await res.json();
        if (!data.success) throw new Error(data.error || 'cms-agent turn failed');

        const parts: any[] = data.parts ?? [];
        totalInput += data.usage?.inputTokens ?? 0;
        totalOutput += data.usage?.outputTokens ?? 0;
        model = data.usage?.model ?? model;

        contents.push({ role: 'model', parts });

        const functionCalls = parts.filter(p => p.functionCall);
        const textParts = parts.filter(p => p.text);

        trace.action('cms-agent:turn-response', {
          requestId,
          turn: turnsRun,
          functionCalls: functionCalls.map(p => p.functionCall.name),
          hasText: textParts.length > 0,
        });

        if (functionCalls.length === 0) {
          // No tool calls — the agent is done.
          for (const p of textParts) finalText += p.text;
          break;
        }

        callbacks.onTurn?.({
          turn: turnsRun,
          toolCalls: functionCalls.map(p => ({ name: p.functionCall.name, args: p.functionCall.args })),
        });

        // Execute each call locally against cms-ops.
        const responseParts: any[] = [];
        for (const part of functionCalls) {
          const { name, args } = part.functionCall;
          const result = executeCmsTool(name, args ?? {});
          toolCallLog.push({ name, args: args ?? {}, isError: result.isError });
          responseParts.push({ functionResponse: { name, response: result.response } });
        }

        contents.push({ role: 'user', parts: responseParts });
      }

      const durationMs = Date.now() - startMs;
      trace.action('cms-agent:done', {
        turns: turnsRun,
        toolCalls: toolCallLog.length,
        errors: toolCallLog.filter(t => t.isError).length,
        durationMs,
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
        trace.error('cms-agent:error', err);
        callbacks.onError(err?.message ?? 'CMS agent failed');
      }
    }
  })();

  return controller;
}
