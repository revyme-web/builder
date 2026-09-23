// src/ai/agent/tools/overrides.ts
//
// Code overrides (audit §10 G4): `overrides/*.tsx` files export
// `withX(Component)` functions; an element wrapped in `<Override with={withX}>`
// gets that behaviour in preview and on the published site (never on the
// canvas). The Code Overrides tool's two moves: author a file, attach exports
// to an element.

import { z } from 'zod';
import { getDefaultStore } from 'jotai';
import type { AgentTool, AgentToolResult } from '@/ai/agent';
import { queueToolMutation, flushTool, getToolNodes, getToolCode, isBranchedRun } from '@/ai/agent/workspace';
import { projectFS, projectVersionAtom } from '@/code/project/project-fs';
import { OVERRIDES_DIR, listOverrideExports, readCodeOverrides, type CodeOverrideRef } from '@/code/generation/code-override-gen';
import { parseJSX } from '@/code/parsing/ast-utils';
import { trace } from '@/shared/debug-trace';

const store = getDefaultStore();

function ok(data: unknown): AgentToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}
function fail(message: string): AgentToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}

const ALLOWED_IMPORT = /^(react|react-dom|framer-motion|next\/[\w/-]+|next-themes|@revyme\/runtime|@\/components\/[\w-]+|@\/overrides\/[\w-]+)$/;

/** What the Code Overrides tool needs of a file: a module whose named exports
 *  are `withX(Component)` functions, importing only what the site can resolve. */
function checkOverrideSource(code: string): string[] {
  const problems: string[] = [];
  const ast = parseJSX(code);
  if (!ast) { problems.push('the file does not parse'); return problems; }
  for (const m of code.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)) {
    if (!ALLOWED_IMPORT.test(m[1])) problems.push(`import "${m[1]}" does not resolve on the site (allowed: react, framer-motion, next/*, @revyme/runtime, @/components/*, @/overrides/*)`);
  }
  const exports = listOverrideExports(code);
  if (exports.length === 0) problems.push('no override export — declare `export function withSomething(Component) { return forwardRef((props, ref) => <Component ref={ref} {...props} … />); }`');
  for (const name of exports) if (!/^with[A-Z]/.test(name)) problems.push(`export "${name}" is not named with<Something> — the tool lists overrides by that prefix`);
  if (/export\s+default/.test(code)) problems.push('an override file has named exports only (no default export)');
  return problems;
}

// ─── write_override ──────────────────────────────────────────────────────────

export const writeOverrideTool: AgentTool = {
  name: 'write_override',
  description:
    'Author (or replace) a CODE OVERRIDE file — overrides/<Name>.tsx exporting `withX(Component)` functions that wrap an element with real behaviour (a store-driven colour, a scroll listener, a hover spring). ' +
    'Shape: `export function withRotate(Component): ComponentType { return forwardRef((props, ref) => <Component ref={ref} {...props} animate={{ rotate: 90 }} />); }` — forward the ref and props; shared state via `createStore` from @revyme/runtime. ' +
    'Then attach it with set_code_overrides. Overrides run in preview and on the site, never on the canvas.',
  inputSchema: {
    name: z.string().describe('file name without extension, PascalCase, e.g. "Effects"'),
    code: z.string().describe('the full file source'),
  },
  category: 'semantic',
  async execute(args, ctx) {
    if (isBranchedRun(ctx)) return fail('write_override works on the active branch only — run unbranched.');
    const name = String(args.name).trim().replace(/\.tsx?$/, '');
    if (!/^[A-Z][A-Za-z0-9]*$/.test(name)) return fail(`"${name}" is not a PascalCase file name.`);
    const code = String(args.code);
    const problems = checkOverrideSource(code);
    if (problems.length) return fail(`The override file was not written:\n- ${problems.join('\n- ')}`);
    const path = `${OVERRIDES_DIR}${name}.tsx`;
    ctx.ensureCheckpoint();
    flushTool(ctx);
    const existed = projectFS.exists(path);
    projectFS.writeFile(path, code);
    store.set(projectVersionAtom, (v) => v + 1);
    const exports = listOverrideExports(code);
    trace.action('agent-tool:write_override', { path, exports, replaced: existed });
    return ok({ file: path, exports, replaced: existed, next: `set_code_overrides {node_id, overrides: [{file: "${path}", name: "${exports[0]}"}]}` });
  },
};

// ─── set_code_overrides ──────────────────────────────────────────────────────

export const setCodeOverridesTool: AgentTool = {
  name: 'set_code_overrides',
  description:
    'Attach code overrides to an element (the Code Overrides section): overrides is the FULL list [{file, name}] of `overrides/*.tsx` exports to wrap it with — [] removes them all. list_overrides names what exists.',
  inputSchema: {
    node_id: z.string(),
    overrides: z.array(z.object({ file: z.string().describe('overrides/<Name>.tsx'), name: z.string().describe('the exported with<X> function') })),
  },
  category: 'semantic',
  async execute(args, ctx) {
    const nodeId = String(args.node_id);
    const node = getToolNodes(ctx).get(nodeId);
    if (!node) return fail(`No node "${nodeId}" in the active file.`);
    const overrides = args.overrides as CodeOverrideRef[];
    for (const o of overrides) {
      const src = projectFS.readFile(o.file);
      if (!src) return fail(`No override file "${o.file}". Files: ${projectFS.listFiles(OVERRIDES_DIR).join(', ') || 'none (write_override creates one)'}.`);
      const exports = listOverrideExports(src);
      if (!exports.includes(o.name)) return fail(`"${o.file}" does not export "${o.name}". Its overrides: ${exports.join(', ') || 'none'}.`);
    }
    ctx.ensureCheckpoint();
    queueToolMutation(ctx, { type: 'setCodeOverrides', nodeId, overrides });
    flushTool(ctx);
    trace.action('agent-tool:set_code_overrides', { nodeId, count: overrides.length });
    return ok({ node_id: nodeId, overrides: overrides.map((o) => `${o.name} (${o.file})`), note: 'runs in preview and on the site; the canvas shows the element without it' });
  },
};

// ─── list_overrides ──────────────────────────────────────────────────────────

export const listOverridesTool: AgentTool = {
  name: 'list_overrides',
  description: 'The project\'s code override files and their with<X> exports; with node_id, which ones that element carries.',
  inputSchema: { node_id: z.string().optional() },
  category: 'read',
  async execute(args, ctx) {
    const files = projectFS.listFiles(OVERRIDES_DIR).filter((f) => /\.(tsx|ts|jsx|js)$/.test(f)).sort();
    const listing = files.map((f) => ({ file: f, exports: listOverrideExports(projectFS.readFile(f) ?? '') }));
    if (args.node_id) return ok({ files: listing, on_node: readCodeOverrides(getToolCode(ctx), String(args.node_id)) });
    return ok({ files: listing });
  },
};

export const OVERRIDE_TOOLS: AgentTool[] = [writeOverrideTool, setCodeOverridesTool, listOverridesTool];
