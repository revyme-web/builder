// generate-codebase-map.ts
//
// Walks the project, parses every .ts/.tsx/.cjs file with the TypeScript
// compiler API, and emits a tree-shaped map of folders → files → exported
// + internal functions, methods, and types. Descriptions are pulled from
// the JSDoc `/** … */` block immediately preceding each declaration. The
// file description comes from the leading block comment (or line-comment
// preamble) at the top of the file.
//
// Outputs (generated artifacts — the output directory is untracked by
// design; run this script to produce a fresh map locally):
//   docs/architecture/codebase-map.md
//   docs/architecture/codebase-map.data.json

import * as ts from 'typescript';
import * as fs from 'fs';
import * as path from 'path';

type Kind = 'fn' | 'type';
interface Sym {
  name: string;
  kind: Kind;
  exported: boolean;
  hasParens: boolean;
  desc?: string;
}
interface FileEntry {
  rel: string;
  lines: number;
  file_desc?: string;
  symbols: Sym[];
}

const ROOT = path.resolve(process.cwd());
const ROOTS = ['src', 'e2e', 'eslint-rules', 'scripts'].map((d) => path.join(ROOT, d));
const ROOT_FILES_GLOB = [
  'vite.config.ts',
  'vite.sandbox.config.ts',
  'vite.preview.config.ts',
  'vitest.config.ts',
  'playwright.config.ts',
];
const OUT_MD = path.join(ROOT, 'docs/architecture/codebase-map.md');
const OUT_JSON = path.join(ROOT, 'docs/architecture/codebase-map.data.json');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      walk(full, out);
    } else if (/\.tsx?$/.test(e.name) || /\.cjs$/.test(e.name)) {
      out.push(full);
    }
  }
  return out;
}

function isExported(node: ts.Node): boolean {
  const mods = (ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined) ?? [];
  return mods.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

function commentToText(comment: string | ts.NodeArray<ts.JSDocComment> | undefined): string | undefined {
  if (!comment) return undefined;
  if (typeof comment === 'string') return comment;
  return comment.map((c) => c.text ?? '').join('');
}

function firstLine(text: string): string {
  const trimmed = text
    .split('\n')
    .map((l) => l.replace(/^\s*\*\s?/, '').trim())
    .filter(Boolean);
  if (trimmed.length === 0) return '';
  const first = trimmed[0];
  return first.replace(/\s+/g, ' ').trim();
}

function jsDocFor(node: ts.Node): string | undefined {
  const withDocs = node as ts.Node & { jsDoc?: ts.JSDoc[] };
  const blocks = withDocs.jsDoc;
  if (!blocks || blocks.length === 0) return undefined;
  const last = blocks[blocks.length - 1];
  const text = commentToText(last.comment);
  if (!text) return undefined;
  const line = firstLine(text);
  return line || undefined;
}

function sourceJsDocBefore(src: string, start: number): string | undefined {
  let i = start - 1;
  while (i >= 0 && /\s/.test(src[i])) i--;
  if (i < 2 || src[i] !== '/' || src[i - 1] !== '*') return undefined;
  const close = i + 1;
  const open = src.lastIndexOf('/**', close);
  if (open < 0) return undefined;
  const block = src.slice(open + 3, close - 2);
  const beforeTag = block.split(/^\s*\*\s*@/m)[0];
  return firstLine(beforeTag) || undefined;
}

function extractFileDesc(src: string): string | undefined {
  const trimmed = src.replace(/^#!.*\n/, '');

  const block = trimmed.match(/^\s*\/\*\*?([\s\S]*?)\*\//);
  if (block) {
    const beforeTag = block[1].split(/^\s*\*\s*@/m)[0];
    const line = firstLine(beforeTag);
    if (line) return line;
  }

  const lineMatch = trimmed.match(/^(\s*\/\/[^\n]*\n)+/);
  if (lineMatch) {
    const lines = lineMatch[0]
      .split('\n')
      .map((l) => l.replace(/^\s*\/\/\s?/, '').trim())
      .filter(Boolean);
    if (lines.length) return lines[0];
  }
  return undefined;
}

function extract(file: string, src: string): { symbols: Sym[]; file_desc?: string } {
  const sf = ts.createSourceFile(
    file,
    src,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const out: Sym[] = [];
  const seen = new Set<string>();
  const push = (s: Sym) => {
    const key = s.name + '|' + s.kind;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(s);
  };

  function describe(node: ts.Node): string | undefined {
    return (
      jsDocFor(node)
      ?? (node.parent ? jsDocFor(node.parent) : undefined)
      ?? sourceJsDocBefore(src, node.getStart(sf))
      ?? undefined
    );
  }

  function visit(node: ts.Node) {
    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const spec of node.exportClause.elements)
        push({ name: spec.name.text, kind: 'fn', exported: true, hasParens: false });
      return;
    }

    if (ts.isFunctionDeclaration(node) && node.name) {
      push({
        name: node.name.text,
        kind: 'fn',
        exported: isExported(node),
        hasParens: true,
        desc: describe(node),
      });
    }

    if (ts.isVariableStatement(node)) {
      const exported = isExported(node);
      for (const decl of node.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) continue;
        const init = decl.initializer;
        const desc = describe(node);
        if (!init) {
          if (exported) push({ name: decl.name.text, kind: 'fn', exported: true, hasParens: false, desc });
          continue;
        }
        if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
          push({ name: decl.name.text, kind: 'fn', exported, hasParens: true, desc });
        } else if (ts.isCallExpression(init) && init.arguments.some((a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a))) {
          push({ name: decl.name.text, kind: 'fn', exported, hasParens: true, desc });
        } else if (exported) {
          push({ name: decl.name.text, kind: 'fn', exported: true, hasParens: false, desc });
        }
      }
    }

    if (ts.isClassDeclaration(node) && node.name) {
      push({
        name: node.name.text,
        kind: 'fn',
        exported: isExported(node),
        hasParens: false,
        desc: describe(node),
      });
      for (const m of node.members) {
        if (ts.isConstructorDeclaration(m)) {
          push({
            name: `${node.name.text}.constructor`,
            kind: 'fn',
            exported: isExported(node),
            hasParens: true,
            desc: describe(m),
          });
        } else if (
          (ts.isMethodDeclaration(m) || ts.isGetAccessorDeclaration(m) || ts.isSetAccessorDeclaration(m))
          && m.name && ts.isIdentifier(m.name as ts.Node)
        ) {
          const prefix = ts.isGetAccessorDeclaration(m) ? 'get ' : ts.isSetAccessorDeclaration(m) ? 'set ' : '';
          push({
            name: `${node.name.text}.${prefix}${(m.name as ts.Identifier).text}`,
            kind: 'fn',
            exported: isExported(node),
            hasParens: true,
            desc: describe(m),
          });
        }
      }
    }

    if (ts.isObjectLiteralExpression(node)) {
      for (const prop of node.properties) {
        if (
          (ts.isMethodDeclaration(prop) || ts.isGetAccessorDeclaration(prop) || ts.isSetAccessorDeclaration(prop))
          && prop.name && ts.isIdentifier(prop.name)
        ) {
          const prefix = ts.isGetAccessorDeclaration(prop) ? 'get ' : ts.isSetAccessorDeclaration(prop) ? 'set ' : '';
          push({
            name: `${prefix}${prop.name.text}`,
            kind: 'fn',
            exported: false,
            hasParens: true,
            desc: describe(prop),
          });
        }
      }
    }

    if (ts.isExportAssignment(node) && node.expression) {
      if (ts.isFunctionExpression(node.expression) || ts.isArrowFunction(node.expression)) {
        push({ name: 'default', kind: 'fn', exported: true, hasParens: true, desc: describe(node) });
      } else if (ts.isIdentifier(node.expression)) {
        push({ name: `default (${node.expression.text})`, kind: 'fn', exported: true, hasParens: false, desc: describe(node) });
      }
    }

    if (ts.isFunctionDeclaration(node) && !node.name) {
      const mods = ts.getModifiers(node) ?? [];
      if (mods.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) {
        push({ name: 'default', kind: 'fn', exported: true, hasParens: true, desc: describe(node) });
      }
    }

    if (ts.isInterfaceDeclaration(node)) {
      push({ name: node.name.text, kind: 'type', exported: isExported(node), hasParens: false, desc: describe(node) });
    }
    if (ts.isTypeAliasDeclaration(node)) {
      push({ name: node.name.text, kind: 'type', exported: isExported(node), hasParens: false, desc: describe(node) });
    }
    if (ts.isEnumDeclaration(node)) {
      push({ name: node.name.text, kind: 'type', exported: isExported(node), hasParens: false, desc: describe(node) });
    }

    ts.forEachChild(node, visit);
  }

  visit(sf);

  return { symbols: out, file_desc: extractFileDesc(src) };
}

interface TreeNode { name: string; dirs: Map<string, TreeNode>; files: FileEntry[]; }
function makeTree(): TreeNode { return { name: '', dirs: new Map(), files: [] }; }
function insert(root: TreeNode, entry: FileEntry) {
  const parts = entry.rel.split('/');
  const fileName = parts.pop()!;
  let node = root;
  for (const p of parts) {
    let child = node.dirs.get(p);
    if (!child) { child = { name: p, dirs: new Map(), files: [] }; node.dirs.set(p, child); }
    node = child;
  }
  node.files.push({ ...entry, rel: fileName });
}

function render(root: TreeNode, totalFiles: number, totalFns: number, totalLines: number): string {
  const out: string[] = [];
  out.push('# Codebase Map — canvas-poc (JSDoc-derived)\n');
  out.push(`**${totalFiles} files** | **${totalFns} functions** | **${totalLines.toLocaleString()} lines**\n`);
  out.push('Generated by `scripts/generate-codebase-map.ts`. Descriptions pulled from JSDoc `/** … */` blocks immediately preceding each declaration.\n');
  out.push('Legend: **bold** = exported, regular = internal, `()` = function/method\n');

  const dash = (s?: string) => s ? s : '';
  function renderNode(node: TreeNode, depth: number) {
    const indent = '  '.repeat(depth);
    for (const key of [...node.dirs.keys()].sort()) {
      const child = node.dirs.get(key)!;
      out.push(`${indent}- 📁 **${key}/** — `);
      renderNode(child, depth + 1);
    }
    for (const f of [...node.files].sort((a, b) => a.rel.localeCompare(b.rel))) {
      out.push(`${indent}- 📄 \`${f.rel}\` (${f.lines} lines) — ${dash(f.file_desc)}`);
      const exports = f.symbols.filter((s) => s.exported && s.kind === 'fn');
      const internals = f.symbols.filter((s) => !s.exported && s.kind === 'fn');
      const types = f.symbols.filter((s) => s.kind === 'type');
      const sub = '  '.repeat(depth + 1);
      if (exports.length) {
        out.push(`${sub}- **Exports:**`);
        for (const s of exports) out.push(`${sub}- \`${s.name}${s.hasParens ? '()' : ''}\` — ${dash(s.desc)}`);
      }
      if (internals.length) {
        out.push(`${sub}- Internal:`);
        for (const s of internals) out.push(`${sub}- \`${s.name}${s.hasParens ? '()' : ''}\` — ${dash(s.desc)}`);
      }
      if (types.length) {
        out.push(`${sub}- Types:`);
        for (const s of types) out.push(`${sub}- \`${s.name}\` — ${dash(s.desc)}`);
      }
    }
  }
  renderNode(root, 0);
  return out.join('\n') + '\n';
}

function main() {
  const files: string[] = [];
  for (const r of ROOTS) if (fs.existsSync(r)) walk(r, files);
  for (const f of ROOT_FILES_GLOB) {
    const full = path.join(ROOT, f);
    if (fs.existsSync(full)) files.push(full);
  }
  files.sort();

  const entries: FileEntry[] = [];
  let totalFns = 0;
  let totalLines = 0;
  for (const full of files) {
    const src = fs.readFileSync(full, 'utf8');
    const lines = src.split('\n').length;
    const rel = path.relative(ROOT, full).replace(/\\/g, '/');
    const { symbols, file_desc } = extract(full, src);
    entries.push({ rel, lines, symbols, file_desc });
    totalFns += symbols.filter((s) => s.kind === 'fn').length;
    totalLines += lines;
  }

  const dataOut: Record<string, unknown> = {};
  for (const e of entries) {
    dataOut[e.rel] = {
      lines: e.lines,
      file_desc: e.file_desc ?? '',
      symbols: Object.fromEntries(e.symbols.map((s) => [
        s.name,
        { kind: s.kind, exported: s.exported, hasParens: s.hasParens, desc: s.desc ?? '' },
      ])),
    };
  }
  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
  fs.writeFileSync(OUT_JSON, JSON.stringify(dataOut, null, 2));

  const root = makeTree();
  for (const e of entries) insert(root, e);
  const md = render(root, files.length, totalFns, totalLines);
  fs.writeFileSync(OUT_MD, md);

  const filesWithDesc = entries.filter((e) => e.file_desc).length;
  const totalSymbols = entries.reduce((n, e) => n + e.symbols.length, 0);
  const symbolsWithDesc = entries.reduce((n, e) => n + e.symbols.filter((s) => s.desc).length, 0);

  console.log(`${files.length} files, ${totalFns} fns, ${totalLines.toLocaleString()} lines`);
  console.log(`MD:   ${OUT_MD}`);
  console.log(`JSON: ${OUT_JSON}`);
  console.log(`Descriptions harvested from JSDoc: ${filesWithDesc}/${files.length} files (${Math.round(filesWithDesc / files.length * 100)}%), ${symbolsWithDesc}/${totalSymbols} symbols (${Math.round(symbolsWithDesc / totalSymbols * 100)}%)`);
}

main();
