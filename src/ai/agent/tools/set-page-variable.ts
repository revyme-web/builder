// src/ai/agent/tools/set-page-variable.ts
//
// Chantier D — interactive content primitives, tool 1/2: set_page_variable.
//
// Declares (or updates) a PAGE variable via the SAME write path the
// PageVariablesModal uses: `queueMutation({ type: 'addPageVariable', …
// })` / `updatePageVariable` → annotation-only. The variable lives in the
// `/** @pageVariables {…} */` block, exactly like a variable the user
// creates in the modal. No useState is emitted here — the codebase
// deliberately defers the hook until the variable is actually REFERENCED
// ("emitting a React hook for an unused variable would create a lint
// warning", page-variables.ts). set_page_interaction addresses the hook
// (see set-page-interaction.ts) because a Set-Variable handler is the point
// where the variable becomes functional.
//
// exports:
//   setPageVariableTool        — the agent tool
//   ensurePageVariableHookInCode(code, name) — shared with
//     set_page_interaction: inserts `const [name, setName] = useState(default)`
//     at the top of the page function when the variable is declared in the
//     annotation, is not a function param (templates/components), and has no
//     useState pair yet. Idempotent, pure string→string.

import { z } from 'zod';
import * as t from '@babel/types';
import generate from '@babel/generator';
import type { AgentTool, AgentToolResult } from '@/ai/agent';
import { queueToolMutation, flushTool, resolveToolFile, readToolFile, getToolNodes } from '@/ai/agent/workspace';
import {
  getPageVariables,
  defaultForType,
  type PageVariable,
  type PageVariableType,
} from '@/code/features/page-variables';
import { parseJSX, traverse } from '@/code/parsing/ast-utils';
import { trace } from '@/shared/debug-trace';
import { isTemplateFilePath } from '@/code/project/file-path-kind';

function ok(data: unknown): AgentToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

function fail(message: string): AgentToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}

/** Exact primitive list + camelCase rule of the PageVariablesModal (src/editor/ui/PageVariablesModal.tsx:32). */
export const PAGE_VARIABLE_TYPES: readonly PageVariableType[] = [
  'number',
  'text',
  'boolean',
  'color',
  'image',
  'componentCursor',
];

/** Mirror of the modal's CAMEL_CASE_RE — zod's regex accepts a RegExp. */
const CAMEL_CASE_RE = /^[a-z][a-zA-Z0-9]*$/;

/** Boolean variables store 'true'/'false' strings (PageVariable.default is a string). */
const BOOLEAN_VALUE_RE = /^(true|false)$/;

// ─── Shared hook-ensure (used by set_page_interaction too) ──────────────────

/** Does the body already carry a `const [name, setName] = useState(…)` pair?
 *  Accepts the canonical `useState` identifier and the `React.useState` form. */
function hasUseStatePair(body: t.BlockStatement, name: string, setName: string): boolean {
  for (const stmt of body.body) {
    if (!t.isVariableDeclaration(stmt)) continue;
    if (stmt.declarations.length !== 1) continue;
    const d = stmt.declarations[0];
    if (!t.isArrayPattern(d.id) || d.id.elements.length !== 2) continue;
    const [valueEl, setterEl] = d.id.elements;
    if (!t.isIdentifier(valueEl) || valueEl.name !== name) continue;
    if (!t.isIdentifier(setterEl) || setterEl.name !== setName) continue;
    if (!d.init || !t.isCallExpression(d.init)) continue;
    const callee = d.init.callee;
    if (t.isIdentifier(callee) && callee.name === 'useState') return true;
    if (t.isMemberExpression(callee) && t.isIdentifier(callee.object) && callee.object.name === 'React' && t.isIdentifier(callee.property) && callee.property.name === 'useState') return true;
  }
  return false;
}

/** Coerce a variable's string default into the JS literal the panel's own
 *  syncPageVariableHooks emits (page-variables-gen.ts defaultExpressionForVariable). */
function defaultLiteralFor(v: PageVariable): t.Expression {
  switch (v.type) {
    case 'number': {
      const n = parseFloat(v.default);
      return Number.isFinite(n) ? t.numericLiteral(n) : t.stringLiteral(v.default);
    }
    case 'boolean':
      return t.booleanLiteral(v.default === 'true');
    case 'text':
    case 'color':
    case 'image':
    case 'componentCursor':
    default:
      return t.stringLiteral(v.default ?? '');
  }
}

/**
 * Ensure the page function declares `const [name, setName] = useState(default)`
 * for a declared (annotated) page variable. Inserts nothing when:
 *   - the variable is not declared in @pageVariables (respect the annotation),
 *   - it is already a function param (templates / components read vars as
 *     destructured props — a useState would be a duplicate declaration),
 *   - the pair already exists.
 * Idempotent. The React import is NOT touched here — callers route the result
 * through modifyProjectFile, whose syncImports pass adds `useState` when the
 * hook text first appears.
 */
export function ensurePageVariableHookInCode(code: string, varName: string): string {
  const config = getPageVariables(code);
  const v = config.find((x) => x.name === varName);
  if (!v) return code;

  const ast = parseJSX(code);
  if (!ast) return code;

  // Locate the page component function — same traversal shapes
  // syncPageVariableHooks accepts (default export function, `export default
  // withResponsiveProps(X)`, or the first top-level function declaration).
  const holder: { fn: t.FunctionDeclaration | null } = { fn: null };
  traverse(ast, {
    ExportDefaultDeclaration(path) {
      const decl = path.node.declaration;
      if (t.isFunctionDeclaration(decl)) {
        holder.fn = decl;
        path.stop();
        return;
      }
      if (t.isIdentifier(decl)) {
        const stmts = (path.findParent((p) => p.isProgram())?.node as t.Program | undefined)?.body ?? [];
        for (const stmt of stmts) {
          if (t.isFunctionDeclaration(stmt) && stmt.id?.name === decl.name) {
            holder.fn = stmt;
            path.stop();
            return;
          }
        }
        return;
      }
      if (t.isCallExpression(decl) && t.isIdentifier(decl.arguments[0])) {
        const arg = decl.arguments[0] as t.Identifier;
        const stmts = (path.findParent((p) => p.isProgram())?.node as t.Program | undefined)?.body ?? [];
        for (const stmt of stmts) {
          if (t.isFunctionDeclaration(stmt) && stmt.id?.name === arg.name) {
            holder.fn = stmt;
            path.stop();
            return;
          }
        }
      }
    },
    FunctionDeclaration(path) {
      if (!holder.fn) {
        holder.fn = path.node;
        path.stop();
      }
    },
  });
  const pageFn = holder.fn;
  if (!pageFn || !t.isBlockStatement(pageFn.body)) return code;

  // Function params (template/component files) must never get a useState.
  const firstParam = pageFn.params?.[0];
  if (firstParam && t.isObjectPattern(firstParam)) {
    for (const p of firstParam.properties) {
      if (t.isObjectProperty(p) && t.isIdentifier(p.key) && p.key.name === varName) return code;
      if (t.isRestElement(p) && t.isIdentifier(p.argument) && p.argument.name === varName) return code;
    }
  }

  const setName = `set${varName.charAt(0).toUpperCase()}${varName.slice(1)}`;
  if (hasUseStatePair(pageFn.body, varName, setName)) return code;

  pageFn.body.body.unshift(
    t.variableDeclaration('const', [
      t.variableDeclarator(
        t.arrayPattern([t.identifier(varName), t.identifier(setName)]),
        t.callExpression(t.identifier('useState'), [defaultLiteralFor(v)]),
      ),
    ]),
  );

  try {
    const out = generate(ast, { retainLines: true }, code);
    trace.action('agent-tool:ensure-page-var-hook', { varName });
    return out.code;
  } catch (err) {
    trace.error('agent-tool:ensure-page-var-hook-failed', { varName, error: err instanceof Error ? err.message : String(err) });
    return code;
  }
}

// ─── set_page_variable ──────────────────────────────────────────────────────

// ─── bind_variable ───────────────────────────────────────────────────────────

const STYLE_PROP_RE = /^[a-z][A-Za-z]*$/;

export const bindVariableTool: AgentTool = {
  name: 'bind_variable',
  description:
    'Bind a PAGE VARIABLE to what a node shows — the text of a text element ("show the counter value in this text") or one CSS property of a node (a colour, an opacity, a size) — so an interaction that sets the variable changes it live. ' +
    'The variable must exist (set_page_variable). bind "text" for the text content, or a camelCase CSS property. Text elements bound this way lose their literal (it becomes the variable\'s default).',
  inputSchema: {
    node_id: z.string(),
    variable: z.string().describe('page variable name'),
    bind: z.string().describe('"text" or a camelCase CSS property, e.g. "backgroundColor", "opacity"'),
  },
  category: 'semantic',
  async execute(args, ctx) {
    ctx.ensureCheckpoint();
    const nodeId = String(args.node_id);
    const name = String(args.variable);
    const bind = String(args.bind);
    const activePath = resolveToolFile(ctx);
    const code = activePath ? readToolFile(ctx, activePath) ?? '' : '';
    const variable = code ? getPageVariables(code).find((v) => v.name === name) : undefined;
    if (!variable) return fail(`No page variable "${name}" — set_page_variable first. Declared: ${getPageVariables(code).map((v) => v.name).join(', ') || 'none'}.`);
    const node = getToolNodes(ctx).get(nodeId);
    if (!node) return fail(`No node "${nodeId}" in the active file.`);
    if (bind === 'text') {
      if (/^[A-Z]/.test(node.type)) return fail(`"${nodeId}" is a component instance — bind one of its text props instead (set_component_prop with the variable is not supported; use a text element).`);
      if (node.textContent === undefined || node.textContent === null) return fail(`"${nodeId}" is not a text element.`);
      queueToolMutation(ctx, { type: 'createTextPageVariable', nodeId, propName: name, defaultValue: variable.default });
    } else {
      if (!STYLE_PROP_RE.test(bind)) return fail(`bind must be "text" or a camelCase CSS property, not "${bind}".`);
      if (variable.type === 'boolean') return fail(`"${name}" is a boolean — a style needs a value variable (color / number / text). Use a variant or set_page_interaction for on/off looks.`);
      queueToolMutation(ctx, { type: 'bindStylePageVariable', nodeId, styleProperty: bind, varName: name });
    }
    flushTool(ctx);
    trace.action('agent-tool:bind_variable', { nodeId, name, bind });
    return ok({ node_id: nodeId, variable: name, bound: bind, type: variable.type, hint: 'set_page_interaction (or a connection) changes the variable at runtime' });
  },
};

export const setPageVariableTool: AgentTool = {
  name: 'set_page_variable',
  description:
    "Declare (or update) a PAGE variable — interactive state for the page.\n\nInputs:\n  name: string — camelCase, e.g. \"faqOpen\" (existing name = update)\n  type: \"number\" | \"text\" | \"boolean\" | \"color\" | \"image\" | \"componentCursor\"\n  value: string (optional) — default as string, e.g. \"false\", \"0.5\", \"#6366f1\"\n\nExample: {\"name\":\"faqOpen\",\"type\":\"boolean\",\"value\":\"false\"}\n\nErrors:\n  - value must be \"true\"/\"false\" for booleans (not \"toggle\")\n  - name must be camelCase (not \"faq_open\")\n\nDoes NOT write conditional rendering ({open && …}) or useState — use apply_file_edit for JSX changes.",
  inputSchema: {
    name: z
      .string()
      .regex(CAMEL_CASE_RE, "variable name must be camelCase (start lowercase, letters and digits only)")
      .describe('camelCase variable name, e.g. "open", "faqIndex", "isDark"'),
    type: z.enum(PAGE_VARIABLE_TYPES).describe("primitive type: 'number' | 'text' | 'boolean' | 'color' | 'image' | 'componentCursor'"),
    value: z
      .string()
      .optional()
      .describe('default value as a string, e.g. "false", "0.5", "#6366f1", "Hello"; omitted → the type default'),
    description: z.string().optional().describe('optional human note (editor metadata, shown in the Page Variables modal)'),
  },
  category: 'semantic',
  async execute(args, ctx) {
    ctx.ensureCheckpoint();
    const name = args.name as string;
    const type = args.type as PageVariableType;
    const rawValue = (args.value as string | undefined)?.trim() ?? '';
    // boolean defaults must stay in the 'true'/'false' string dialect the
    // annotation + hook sync expect — anything else would silently coerce
    // to false at runtime.
    if (type === 'boolean' && rawValue !== '' && !BOOLEAN_VALUE_RE.test(rawValue)) {
      return fail(`boolean variable default must be 'true' or 'false', got "${rawValue}".`);
    }
    if (type === 'number' && rawValue !== '' && !Number.isFinite(parseFloat(rawValue))) {
      return fail(`number variable default must be a number, got "${rawValue}".`);
    }
    const variable: PageVariable = {
      name,
      type,
      default: rawValue === '' ? defaultForType(type) : rawValue,
    };
    if (typeof args.description === 'string' && args.description) variable.description = args.description;

    const activePath = resolveToolFile(ctx);
    const code = activePath ? readToolFile(ctx, activePath) ?? '' : '';
    const existing = code ? getPageVariables(code).find((v) => v.name === name) : undefined;

    if (existing) {
      // Update in place — only the provided fields change (same contract as
      // the modal's save: updatePageVariable, annotation-only).
      const updates: Partial<PageVariable> = {};
      if (type !== existing.type) updates.type = type;
      if (variable.default !== existing.default) updates.default = variable.default;
      if (variable.description) updates.description = variable.description;
      queueToolMutation(ctx, { type: 'updatePageVariable', oldName: name, updates });
      flushTool(ctx);
      trace.action('agent-tool:set_page_variable', { action: 'updated', name, type });
      return ok({ action: 'updated', variable: name, type, default: variable.default });
    }

    // A TEMPLATE reads its variables as function params (the Template tool
    // lists them and pages override them per route) — never useState. The
    // panel's ControlProvider does the same (ensureTemplateVarParam).
    if (isTemplateFilePath(activePath)) {
      const literalKind = type === 'number' ? 'number' : type === 'boolean' ? 'boolean' : 'string';
      queueToolMutation(ctx, { type: 'addPageVariable', variable });
      queueToolMutation(ctx, { type: 'ensureTemplateVarParam', name, defaultValue: variable.default, varType: type === 'text' ? 'plainText' : type, literalKind });
      flushTool(ctx);
      trace.action('agent-tool:set_page_variable', { action: 'created-template-param', name, type });
      return ok({ action: 'created', variable: name, type, default: variable.default, scope: 'template', hint: 'a template variable is a prop of the layout — each page can override it in the Template tool; bind_variable binds it to a text or style.' });
    }
    queueToolMutation(ctx, { type: 'addPageVariable', variable });
    flushTool(ctx);
    trace.action('agent-tool:set_page_variable', { action: 'created', name, type });
    return ok({ action: 'created', variable: name, type, default: variable.default, hint: 'set_page_interaction wires a node to set it at runtime.' });
  },
};