// src/ai/agent/tools/screenshot.ts
// get_screenshot — capture a viewport (or multi-viewport) as an image
// and return image blocks + systematic text metadata.
// Uses waitForRender for bounded polling, then captureElement via the bridge.

import { z } from 'zod';
import type { AgentTool, AgentToolResult } from '@/ai/agent';
import { waitForRender } from './wait-for-render';
import { getCanvasBridge } from '@/canvas/canvas-bridge';
import { findNodeRect, getViewportPrefix } from '@/canvas/node-ops';
import { projectFS } from '@/code/project/project-fs';
import { trace } from '@/shared/debug-trace';

const screenshotShape = {
  viewport: z.string().optional().default('active').describe('viewport id, default active'),
  viewports: z.array(z.string()).optional().describe('optional multiple viewport ids'),
  pixelRatio: z.number().optional().default(1).describe('pixel ratio, default 1'),
  format: z.enum(['png', 'jpeg']).optional().default('png').describe('image format png or jpeg, default png'),
};

const captureSchema = z.object(screenshotShape);

export const getScreenshotTool: AgentTool = {
  name: 'get_screenshot',
  description:
    'Capture the current viewport (or specified viewports) as an image data URL, with systematic metadata (viewport, dimensions, status, waitedMs). Use when visual inspection by the reads is insufficient — never in routine edits, never blocking, nothing gates on it.',
  inputSchema: screenshotShape,
  category: 'meta',
  async execute(args, ctx?): Promise<AgentToolResult> {
    const parsed = captureSchema.safeParse(args);
    if (!parsed.success) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: `Invalid arguments: ${parsed.error.message}`, guidance: 'Check viewport/viewports, pixelRatio and format.' }) }],
        isError: true,
      };
    }
    // P8 (vi): a capture shows the HUMAN canvas — never capture the wrong
    // tree for a branched run. Honest unavailable, non-blocking (P6 §13).
    if (ctx?.workspace) {
      if (ctx.workspace.branchId !== projectFS.getActiveBranchId()) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                status: 'unavailable' as const,
                waitedMs: 0,
                note: `The canvas shows another branch — no live render of "${ctx.workspace.branchId}" exists here. Verify with verify_effect (code) or preview the branch.`,
              }),
            },
          ],
        };
      }
    }
    const { viewport, viewports, pixelRatio, format } = parsed.data;

    const vpList: string[] =
      viewports && viewports.length > 0 ? viewports : [viewport ?? 'active'];

    const content: AgentToolResult['content'] = [];

    for (const vpId of vpList) {
      const vpPrefix = getViewportPrefix(vpId);

      // Bounded wait for rect cache — short bound (800ms) as per ticket.
      let waitStatus: 'ready' | 'pending' | 'unavailable' = 'pending';
      let waitedMs = 0;
      try {
        const waitRes = await waitForRender({ vpId, timeoutMs: 800, intervalMs: 100 });
        waitStatus = waitRes.status as typeof waitStatus;
        waitedMs = waitRes.waitedMs;
      } catch {
        waitStatus = 'unavailable';
        waitedMs = 0;
      }

      if (waitStatus === 'unavailable') {
        const rect = findNodeRect('root', vpId);
        const width = rect?.width ?? 0;
        const height = rect?.height ?? 0;
        const payload = {
          viewport: vpId,
          width,
          height,
          status: 'unavailable' as const,
          waitedMs,
          note: `Unknown viewport "${vpId}" — no width match. Vérifiez le viewport id. Assurez backgroundColor et réessayez après rendu.`,
        };
        trace.fn('screenshot:capture', { vpId, bytes: 0, status: 'unavailable', waitedMs });
        content.push({ type: 'text', text: JSON.stringify(payload) });
        continue;
      }

      if (waitStatus === 'pending') {
        const rect = findNodeRect('root', vpId);
        const width = rect?.width ?? 0;
        const height = rect?.height ?? 0;
        const payload = {
          viewport: vpId,
          width,
          height,
          status: 'pending' as const,
          waitedMs,
          note: 'No rects cached yet — the canvas may be mid-render; wait a moment and call again. Conseil : réessayez après le rendu.',
        };
        trace.fn('screenshot:capture', { vpId, bytes: 0, status: 'pending', waitedMs });
        content.push({ type: 'text', text: JSON.stringify(payload) });
        continue;
      }

      // ready — attempt capture
      const bridge = getCanvasBridge() as unknown as {
        captureElement?: (nodeId: string, vpPrefix: string, opts: { format: 'png' | 'jpeg' | 'svg'; pixelRatio: number; backgroundColor?: string }) => Promise<string | null>;
      };

      let dataUrl: string | null = null;
      const captureOpts: { format: 'png' | 'jpeg'; pixelRatio: number; backgroundColor?: string } = {
        format: format as 'png' | 'jpeg',
        pixelRatio,
        backgroundColor: format === 'jpeg' ? '#ffffff' : undefined,
      };

      if (typeof bridge.captureElement === 'function') {
        try {
          dataUrl = await bridge.captureElement('root', vpPrefix, captureOpts);
        } catch {
          dataUrl = null;
        }
      } else {
        dataUrl = null;
      }

      const rect = findNodeRect('root', vpId);
      const width = rect?.width ?? 0;
      const height = rect?.height ?? 0;

      if (!dataUrl) {
        const payload = {
          viewport: vpId,
          width,
          height,
          status: 'unavailable' as const,
          waitedMs,
          note: 'Capture returned null — canvas may be tainted, element not found, or bridge unavailable. Vérifiez backgroundColor (ex. "#ffffff" pour jpeg), puis réessayez après rendu.',
        };
        trace.fn('screenshot:capture', { vpId, bytes: 0, status: 'unavailable', waitedMs });
        content.push({ type: 'text', text: JSON.stringify(payload) });
        continue;
      }

      const bytes = dataUrl.length;
      trace.fn('screenshot:capture', { vpId, bytes, status: 'ready', waitedMs });
      const meta = {
        viewport: vpId,
        width,
        height,
        status: 'ready' as const,
        waitedMs,
      };
      content.push({ type: 'image', dataUrl, alt: `screenshot ${vpId}` });
      content.push({ type: 'text', text: JSON.stringify(meta) });
    }

    if (content.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              viewport: vpList[0] ?? 'active',
              width: 0,
              height: 0,
              status: 'unavailable',
              waitedMs: 0,
              note: 'No viewport captured — check bridge and viewport ids. backgroundColor guidance: ensure canvas not tainted, réessayez après rendu.',
            }),
          },
        ],
      };
    }

    return { content };
  },
};
