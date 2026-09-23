// src/ai/agent/tools/assets.ts
//
// The 3D asset library and the media library (audit §11): both were MCP-only
// (`revyme_find_assets`, `revyme_upload_image`). `find_assets` reads the
// catalog the service keeps; `upload_image` re-hosts an image in the user's
// own storage — the service downloads the bytes (the browser cannot fetch
// cross-origin sources) and the tab uploads them through its authed session,
// the same quota-counted path as a file dropped on the canvas.

import { z } from 'zod';
import type { AgentTool, AgentToolResult } from '@/ai/agent';
import { bridgeHandlers } from '@/ai/mcp/bridge-client';
import { trace } from '@/shared/debug-trace';

const AI_SERVICE_URL = import.meta.env.VITE_AI_SERVICE_URL || 'http://localhost:8082';

function ok(data: unknown): AgentToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}
function fail(message: string): AgentToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}

const MATERIALS = ['glass', 'neon-glass', 'frosted-glass', 'clear-glass', 'clay', 'aluminum', 'copper', 'plastic', 'illustration'] as const;

export const findAssetsTool: AgentTool = {
  name: 'find_assets',
  description:
    'Search the 3D asset library — glossy, transparent-background 3D icons and illustrations (glass, neon-glass, frosted-glass, clay, aluminum, copper, plastic). Returns image URLs to use in an <img> (set_attr src) or a fill; upload_image re-hosts one in the project. ' +
    'Filters: material, color (yellow, black, neon, silver, clear, iridescent, copper…), subject (sphere, number, block, arrow, capsule, device, social-icon…).',
  inputSchema: {
    query: z.string().optional().describe('free text, e.g. "glass sphere", "copper arrow"'),
    material: z.enum(MATERIALS).optional(),
    color: z.string().optional(),
    subject: z.string().optional(),
    limit: z.number().int().min(1).max(60).optional(),
  },
  category: 'read',
  async execute(args, ctx) {
    const q = new URLSearchParams();
    for (const k of ['query', 'material', 'color', 'subject', 'limit'] as const) if (args[k] != null && args[k] !== '') q.set(k, String(args[k]));
    try {
      const res = await fetch(`${AI_SERVICE_URL}/api/agent/assets?${q}`, { signal: ctx?.signal });
      const body = await res.json() as { success?: boolean; error?: string; count?: number; assets?: unknown[] };
      if (!res.ok || !body.success) return fail(body.error ?? `Asset search failed (${res.status}).`);
      trace.action('agent-tool:find_assets', { query: args.query, count: body.count });
      return ok({ count: body.count, assets: body.assets, next: 'set_attr {src} on an <img>, or upload_image to keep a copy in the project' });
    } catch (err) {
      return fail(`Could not reach the asset service: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
};

export const uploadImageTool: AgentTool = {
  name: 'upload_image',
  description:
    'Save an image into the project\'s OWN media library (the user\'s storage, counted against their quota) and get a permanent URL on their CDN — for a search_images / find_assets result or any public image URL the site should not depend on. ' +
    'Pass url (public http(s)) or data_base64 (raw bytes, no data: prefix) with content_type. Returns the hosted url.',
  inputSchema: {
    url: z.string().optional(),
    data_base64: z.string().optional(),
    content_type: z.string().optional(),
    filename: z.string().optional(),
  },
  category: 'semantic',
  async execute(args, ctx) {
    let dataBase64 = typeof args.data_base64 === 'string' ? args.data_base64 : '';
    let contentType = typeof args.content_type === 'string' ? args.content_type : undefined;
    let filename = typeof args.filename === 'string' ? args.filename : undefined;
    const src = typeof args.url === 'string' ? args.url.trim() : '';
    if (!dataBase64 && !src) return fail('Pass url or data_base64.');
    if (!dataBase64) {
      if (!/^https?:\/\//i.test(src)) return fail('`url` must be an http(s) URL.');
      try {
        const res = await fetch(`${AI_SERVICE_URL}/api/agent/fetch-bytes?url=${encodeURIComponent(src)}`, { signal: ctx?.signal });
        const body = await res.json() as { success?: boolean; error?: string; dataBase64?: string; contentType?: string; filename?: string };
        if (!res.ok || !body.success || !body.dataBase64) return fail(body.error ?? `Could not download the image (${res.status}).`);
        dataBase64 = body.dataBase64;
        contentType = contentType ?? body.contentType;
        filename = filename ?? body.filename;
      } catch (err) {
        return fail(`Could not reach the download service: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    try {
      ctx.ensureCheckpoint();
      const result = await bridgeHandlers.uploadImage({ dataBase64, contentType, filename }) as { url: string };
      trace.action('agent-tool:upload_image', { source: src || 'bytes', url: result.url });
      return ok({ url: result.url, source: src || null, next: 'set_attr {src} / set_styles {backgroundImage: url(...)} with this url' });
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
};

export const ASSET_TOOLS: AgentTool[] = [findAssetsTool, uploadImageTool];
