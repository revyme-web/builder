// src/ai/agent/tools/images.ts
//
// `search_images` — real photographs for the agent. It had no way to get a
// picture, so it left them out (a blog whose eight posts have no cover) or made
// a URL up (a broken image). The search itself, and the Unsplash key, live in
// the SERVICE (ai-generator agent/images.ts); this is the hand that asks — the
// same split as `load_manual`.
//
// A READ: it changes nothing. Using a result is an ordinary edit — a
// `backgroundImage` through set_styles / add_node on a page, a plain URL value
// through the cms_* tools.

import { z } from 'zod';
import type { AgentTool } from '@/ai/agent';
import { trace } from '@/shared/debug-trace';

const AI_SERVICE_URL = import.meta.env.VITE_AI_SERVICE_URL || 'http://localhost:8082';

export const searchImagesTool: AgentTool = {
  name: 'search_images',
  description:
    'Find real photographs (Unsplash). Use it WHENEVER a design or a collection needs a picture — NEVER write an image URL from memory, an invented URL is a broken image. ' +
    'Write `query` like a photo caption specific to this site ("barista pouring latte art, warm light", not "coffee"). One search per distinct subject; ask for several and use DIFFERENT results across cards / items. ' +
    'Each result: `url` (ready to use), `alt` (what is in the picture — you cannot see it, so read this), `width`×`height` of the original, `color` (dominant), `author`. ' +
    "ON A PAGE use it as a frame: a div with backgroundImage: 'url(<url>)', backgroundSize: 'cover', backgroundPosition: 'center' and a real size — never an <img>. IN THE CMS an image field's value is the bare `url`.",
  inputSchema: {
    query: z.string().describe('what the picture should show, like a caption'),
    count: z.number().optional().describe('how many results, 1-12 (default 6)'),
    orientation: z.enum(['landscape', 'portrait', 'squarish']).optional()
      .describe('landscape: heroes, wide cards · portrait: people, tall cards · squarish: avatars, grids'),
    width: z.number().optional().describe('delivery width in px for the returned urls — ~800 for a card, 1600 for a full-bleed hero (default 1600)'),
  },
  category: 'read',
  async execute(args, ctx) {
    const params = new URLSearchParams({ query: String(args.query ?? '') });
    if (args.count != null) params.set('count', String(args.count));
    if (args.orientation) params.set('orientation', String(args.orientation));
    if (args.width != null) params.set('width', String(args.width));
    try {
      const res = await fetch(`${AI_SERVICE_URL}/api/agent/images?${params}`, { signal: ctx?.signal });
      const body = await res.json() as { results?: unknown[]; error?: string };
      if (!res.ok || body.error || !body.results) {
        trace.error('agent-images:search-failed', { status: res.status, error: body.error });
        const error = body.error ?? `Image search failed (${res.status}). Do NOT invent image URLs — carry on without images and say so.`;
        return { content: [{ type: 'text', text: JSON.stringify({ error }) }], isError: true };
      }
      trace.action('agent-images:search', { query: args.query, results: body.results.length });
      if (body.results.length === 0) {
        return { content: [{ type: 'text', text: JSON.stringify({ results: [], hint: 'Nothing matched — try a broader or differently worded query. Do NOT invent a URL.' }) }] };
      }
      return { content: [{ type: 'text', text: JSON.stringify({ results: body.results }) }] };
    } catch (err) {
      trace.error('agent-images:search-threw', { error: String(err) });
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: `Image search could not be reached (${err instanceof Error ? err.message : String(err)}). Do NOT invent image URLs — carry on without images and say so.` }) }],
        isError: true,
      };
    }
  },
};
