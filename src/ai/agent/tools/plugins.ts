// src/ai/agent/tools/plugins.ts
//
// Editor PLUGINS authored in the project (audit §10 G6): `plugins/<Name>.tsx`,
// one self-contained file, compiled in the browser and launched from the
// Library — the Plugin panel's own primitives (plugin-files.ts). The SDK
// surface the model writes against is the `plugin` manual (load_manual).
// The same file is the `src/main.tsx` of a marketplace plugin project
// (`@revyme/plugin-tools pack`).

import { z } from 'zod';
import { getDefaultStore } from 'jotai';
import type { AgentTool, AgentToolResult } from '@/ai/agent';
import { flushTool, isBranchedRun } from '@/ai/agent/workspace';
import { projectFS, projectVersionAtom } from '@/code/project/project-fs';
import { listPluginFiles, writePluginSource, getPluginDisplayName, toPascalCase } from '@/editor/plugin-editor/plugin-files';
import { launchedProjectPluginAtom, openPluginIdAtom } from '@/plugins/registry';
import { parseJSX } from '@/code/parsing/ast-utils';
import { trace } from '@/shared/debug-trace';

const store = getDefaultStore();

function ok(data: unknown): AgentToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}
function fail(message: string): AgentToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}

const PLUGINS_DIR = 'plugins/';
const pathFor = (name: string): string => `${PLUGINS_DIR}${name}.tsx`;

/** What the in-browser bundler and the runtime need of a plugin file. */
function checkPluginSource(code: string): string[] {
  const problems: string[] = [];
  if (!parseJSX(code)) { problems.push('the file does not parse as TSX'); return problems; }
  if (!/from ['"]@revyme\/plugin-sdk['"]/.test(code) || !/\bcreatePlugin\b/.test(code)) problems.push("import { createPlugin } from '@revyme/plugin-sdk' and call `await createPlugin({ pluginId })`");
  if (!/from ['"]react-dom\/client['"]/.test(code) || !/createRoot\s*\(/.test(code)) problems.push("import { createRoot } from 'react-dom/client' and render the App into document.getElementById('root')");
  if (!/pluginId\s*:\s*['"]local\.[a-z0-9-]+['"]/.test(code)) problems.push('createPlugin needs { pluginId: "local.<lower-kebab-name>" }');
  if (/export\s+default/.test(code)) problems.push('a plugin file has no default export — it mounts itself with createRoot(...).render(...)');
  for (const m of code.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)) {
    const spec = m[1];
    if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('@/')) problems.push(`import "${spec}" — a plugin is ONE self-contained file; only bare npm packages resolve (esm.sh) plus react, react-dom/client, @revyme/plugin-sdk`);
  }
  if (/plugin\.revyme\.(variables\.(get|set)|assets\.setImage|components\.addDetachedComponentLayers|codeFiles\.(lint|typecheck|getVersions))\b/.test(code)) problems.push('uses an SDK method marked [NOT_IMPLEMENTED] in the plugin manual — it throws at runtime');
  return problems;
}

// ─── list_plugins ────────────────────────────────────────────────────────────

export const listPluginsTool: AgentTool = {
  name: 'list_plugins',
  description: 'The project\'s editor plugins (plugins/<Name>.tsx) with their display names. read_file one to see its source; write_plugin to change or add one.',
  inputSchema: {},
  category: 'read',
  async execute() {
    const files = listPluginFiles();
    return ok({ plugins: files.map((f) => ({ file: f, name: f.replace(PLUGINS_DIR, '').replace(/\.tsx$/, ''), display_name: getPluginDisplayName(f) })) });
  },
};

// ─── write_plugin ────────────────────────────────────────────────────────────

export const writePluginTool: AgentTool = {
  name: 'write_plugin',
  description:
    'Author or replace an editor PLUGIN — plugins/<Name>.tsx, a self-contained React app on the plugin SDK (load_manual "plugin" for the SDK surface and the authoring shape). ' +
    'Validated before writing: parses, imports createPlugin + createRoot, `createPlugin({ pluginId: "local.<name>" })`, no relative / @/ imports (bare npm packages resolve through esm.sh), no [NOT_IMPLEMENTED] SDK method. Then launch_plugin to open it.',
  inputSchema: {
    name: z.string().describe('plugin name, e.g. "Color Palette" → plugins/ColorPalette.tsx'),
    code: z.string().describe('the full file source'),
  },
  category: 'semantic',
  async execute(args, ctx) {
    if (isBranchedRun(ctx)) return fail('write_plugin works on the active branch only — run unbranched.');
    const name = toPascalCase(String(args.name));
    const code = String(args.code);
    const problems = checkPluginSource(code);
    if (problems.length) return fail(`The plugin was not written:\n- ${problems.join('\n- ')}`);
    const path = pathFor(name);
    const existed = projectFS.exists(path);
    ctx.ensureCheckpoint();
    flushTool(ctx);
    if (existed) writePluginSource(path, code);
    else projectFS.writeFile(path, code);
    store.set(projectVersionAtom, (v) => v + 1);
    trace.action('agent-tool:write_plugin', { path, replaced: existed, bytes: code.length });
    return ok({ file: path, name, replaced: existed, next: `launch_plugin {name: "${name}"} opens it in the editor` });
  },
};

// ─── launch_plugin ───────────────────────────────────────────────────────────

export const launchPluginTool: AgentTool = {
  name: 'launch_plugin',
  description: 'Open a project plugin in the editor (compiles plugins/<Name>.tsx and shows its window) — what clicking it in the Library does. Pass name "" to close the plugin window.',
  inputSchema: { name: z.string().describe('plugin name from list_plugins; "" closes') },
  category: 'semantic',
  async execute(args) {
    const name = toPascalCase(String(args.name));
    if (String(args.name).trim() === '') {
      store.set(launchedProjectPluginAtom, null);
      return ok({ launched: null });
    }
    const path = pathFor(name);
    if (!projectFS.exists(path)) return fail(`No plugin "${name}". list_plugins names them; write_plugin creates one.`);
    store.set(openPluginIdAtom, null);
    store.set(launchedProjectPluginAtom, path);
    trace.action('agent-tool:launch_plugin', { path });
    return ok({ launched: path, note: 'the plugin window is open in the editor; errors it throws show there' });
  },
};

export const PLUGIN_TOOLS: AgentTool[] = [listPluginsTool, writePluginTool, launchPluginTool];
