// src/ai/agent/tools/links.ts
//
// `set_link` — make an element navigate, the way the Link tool does it.
//
// The agent's only way to link was `change_tag` to `a` + `set_attr` href —
// which the oracle rejects on a page (PAGE_LINK_NOT_NEXTLINK: a raw <a> does a
// full reload and drops the client-side navigation Next.js pages rely on). The
// Link tool has a whole write sequence the agent never had: internal links
// become <Link> (or <MotionLink> on a component master, so framer-motion props
// survive), external ones stay <a> with rel, anchor links get their scroll
// handler, and removing the link reverts the element to a plain container
// (a href-less <Link> crashes SSR). Same mutations, same order.

import { z } from 'zod';
import type { AgentTool, AgentToolResult, ToolContext } from '@/ai/agent';
import { queueToolMutation, flushTool, getToolNodes, resolveToolFile } from '@/ai/agent/workspace';
import { isComponentFilePath } from '@/code/project/active-file-store';
import { trace } from '@/shared/debug-trace';

function ok(data: unknown): AgentToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}
function fail(message: string): AgentToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}

const LINK_TAGS = new Set(['a', 'Link', 'MotionLink']);

export function isExternalHref(href: string): boolean {
  return /^(https?:\/\/|mailto:|tel:)/.test(href);
}

export const setLinkTool: AgentTool = {
  name: 'set_link',
  description:
    'Make an element a LINK, or change where it goes — the same write as the Link tool. `href` is a page route ("/about", "/blog/hello"), an anchor on this page ("#pricing"), or an external URL ("https://…", "mailto:…"). ' +
    'Internal links become a Next.js <Link> (client-side navigation); external ones an <a> with rel="noopener noreferrer"; on a component master an internal link is a <MotionLink> so the master\'s motion keeps working. ' +
    'Optional new_tab (opens in a new tab) and smooth_scroll (for "#anchor" hrefs). Pass href "" to REMOVE the link: the element becomes a plain container again. ' +
    'Never write a raw <a href> with change_tag + set_attr on a page — the oracle rejects it.',
  inputSchema: {
    node_id: z.string().describe('data-id of the element to link'),
    href: z.string().describe('page route "/about", anchor "#pricing", external "https://…" — or "" to remove the link'),
    new_tab: z.boolean().optional().describe('open in a new tab'),
    smooth_scroll: z.boolean().optional().describe('for "#anchor" hrefs: scroll smoothly instead of jumping'),
  },
  category: 'semantic',
  async execute(args, ctx: ToolContext) {
    const nodeId = String(args.node_id);
    const href = String(args.href ?? '').trim();
    const node = getToolNodes(ctx).get(nodeId);
    if (!node) return fail(`No node "${nodeId}" in the active file.`);
    const currentType = node.type || 'div';
    const onMaster = isComponentFilePath(resolveToolFile(ctx));
    ctx.ensureCheckpoint();

    if (!href) {
      // Remove: revert to a container, drop the link attrs. A href-less <Link>
      // would crash at render, so the tag goes first.
      if (currentType === 'MotionLink') queueToolMutation(ctx, { type: 'changeTag', nodeId, newTag: 'motion.div' });
      else if (LINK_TAGS.has(currentType)) queueToolMutation(ctx, { type: 'changeTag', nodeId, newTag: 'div' });
      queueToolMutation(ctx, { type: 'updateHtmlAttrs', nodeId, attrs: { href: '', target: '', rel: '', 'data-smooth-scroll': '' } });
      if (LINK_TAGS.has(currentType)) queueToolMutation(ctx, { type: 'updateStyles', nodeId, styles: { textDecoration: '', color: '' } });
      flushTool(ctx);
      trace.action('agent-tool:set_link', { nodeId, removed: true });
      return ok({ node_id: nodeId, link: null });
    }

    const external = isExternalHref(href);
    let tag: string;
    if (onMaster && !external) {
      tag = 'MotionLink';
      if (currentType !== 'MotionLink') queueToolMutation(ctx, { type: 'convertToMotionLink', nodeId });
    } else {
      tag = external ? 'a' : 'Link';
      if (currentType !== tag) {
        queueToolMutation(ctx, { type: 'changeTag', nodeId, newTag: tag });
        queueToolMutation(ctx, { type: 'updateStyles', nodeId, styles: { textDecoration: 'none', color: 'inherit' } });
      }
    }
    const attrs: Record<string, string> = { href };
    if (external) attrs.rel = 'noopener noreferrer';
    if (args.new_tab !== undefined) attrs.target = args.new_tab ? '_blank' : '';
    if (args.smooth_scroll !== undefined) attrs['data-smooth-scroll'] = args.smooth_scroll ? 'true' : '';
    queueToolMutation(ctx, { type: 'updateHtmlAttrs', nodeId, attrs });
    // Anchor hrefs scroll on click through a handler the builder keeps in sync
    // (native hash navigation is unreliable across the canvas and the site).
    queueToolMutation(ctx, { type: 'syncLinkHandler', nodeId });
    flushTool(ctx);
    trace.action('agent-tool:set_link', { nodeId, href, tag, external });
    return ok({ node_id: nodeId, href, tag, external, ...(args.new_tab !== undefined ? { new_tab: !!args.new_tab } : {}) });
  },
};
