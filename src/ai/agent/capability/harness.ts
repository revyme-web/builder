// capability/harness.ts — run ONE capability case against the real builder.
//
// A case answers: "for this Revyme feature, IF the agent makes the right call,
// does Revyme do the right thing — validly?" It is driven through the SAME
// entry point the live agent uses (`agentToolCall`: schema validation, the
// turn checkpoint, the agent write window), over the real in-memory ProjectFS,
// the real mutation queue, the real generators, the real parser and the real
// oracle. Nothing about the builder is mocked; only the network is absent.
//
// Every case is checked TWICE, because each check catches what the other
// cannot:
//   VALID     every file the case changed passes the oracle for its kind. A
//             tool can succeed and still write source the gate would refuse.
//   INTENDED  the file is re-read with the real parser and the case asserts the
//             effect is actually there. A tool can reply "ok" and change
//             nothing — and the file is still perfectly valid.

import { getDefaultStore } from 'jotai';
import { activeFilePathAtom } from '@/code/project/active-file-store';
import {
  initMutationQueue, syncQueueCode, setActiveFilePath, flushNow,
} from '@/code/mutation/mutation-queue';
import { resetProjectFS, projectFS, projectVersionAtom } from '@/code/project/project-fs';
import { selectedIdsAtom, seedNodesForCode, codeAtom } from '@/code/stores/store';
import { bumpProjectVersion } from '@/code/project/modify-file';
import { checkFile } from '@/code/oracle/check-file';
import { oracleFileKind, isBuilderMaterializedFile } from '@/code/oracle/file-kind';
import type { FileKind, OracleViolation } from '@/code/oracle/check-file';
import { parseJSXToNodes, type CanvasNode } from '@/code/parsing/parser';
import { agentToolCall, agentRunStart, agentRunEnd } from '@/ai/agent/bridge-tools';
import { findTool } from '@/ai/agent/tool-manifest';
import { componentEditorFileAtom } from '@/code/stores/component-editor-store';
import { cmsEditorOpenAtom, cmsEditorCollectionAtom } from '@/code/stores/cms-editor-store';
import { FIXTURE_FILES, HOME } from './fixture';

export type Domain =
  | 'components' | 'cms' | 'typography' | 'layout' | 'motion' | 'i18n-vars-forms' | 'code-plugins-templates' | 'pages-assets' | 'branching' | 'skills';

export interface ToolCall { tool: string; args: Record<string, unknown> }

/** What a case can look at once its calls have run. */
/** The opening tag that carries `data-id="<id>"` — brace-aware, so a `=>`
 *  inside an inline handler does not end it early. */
export function openingTag(code: string, id: string): string {
  const i = code.indexOf(`data-id="${id}"`);
  if (i < 0) return '';
  const start = code.lastIndexOf('<', i);
  let depth = 0;
  let quote: string | null = null;
  for (let k = start; k < code.length; k++) {
    const ch = code[k];
    if (quote) { if (ch === quote && code[k - 1] !== '\\') quote = null; continue; }
    if (depth === 0 && (ch === '"' || ch === "'")) { quote = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    else if (ch === '>' && depth === 0) return code.slice(start, k + 1);
  }
  return code.slice(start);
}

export interface CaseWorld {
  /** Raw source of a project file, after every queued write was flushed. */
  read(path: string): string | null;
  /** The file re-parsed by the REAL parser: id → node. */
  nodes(path?: string): Map<string, CanvasNode>;
  node(id: string, path?: string): CanvasNode;
  /** The opening tag carrying this data-id (see openingTag). */
  tag(id: string, path?: string): string;
  /** JSON file, parsed. */
  json<T = unknown>(path: string): T;
  /** Each call's reply, in order. */
  replies: { tool: string; isError: boolean; text: string; data: any }[];
  /** Files that differ from the fixture. */
  changed: string[];
}

export interface CapabilityCase {
  /** Stable id: `<domain>/<slug>`. */
  id: string;
  domain: Domain;
  /** The feature, in the builder's words. One row of the audit's matrices. */
  feature: string;
  /** What a user would say. Level two (live evals) hands ONLY this to the model. */
  ask: string;
  /**
   * `supported`  the agent has a way, and this case proves it end to end.
   * `missing`    no tool yet — a visible gap, never silently absent.
   */
  status: 'supported' | 'missing';
  /** Why it is missing / what would close it (missing cases only). */
  gap?: string;
  /** Extra / replacement files on top of the fixture project. */
  files?: Record<string, string>;
  /** File the user has open (default: the home page). */
  activeFile?: string;
  selection?: string[];
  /** The reference solution: the calls a competent agent makes. */
  calls?: ToolCall[];
  /** INTENDED: assert the effect really landed. Throw to fail. */
  expect?: (world: CaseWorld) => void;
  /** A case ABOUT a refusal: failed calls are expected and judged in `expect`. */
  allowFailedCalls?: boolean;
  /** Oracle codes this case is ALLOWED to leave behind (pre-existing in the
   *  fixture, or a documented rule the builder itself violates). Keep empty. */
  allowViolations?: string[];
}

export interface CaseResult {
  id: string;
  ok: boolean;
  /** Human-readable reasons, empty when ok. */
  failures: string[];
}

const store = getDefaultStore();

const kindOf = oracleFileKind;

function activate(path: string): void {
  flushNow();
  store.set(selectedIdsAtom, []);
  store.set(activeFilePathAtom, path);
  setActiveFilePath(path);
  const code = projectFS.readFile(path) ?? '';
  syncQueueCode(code);
  store.set(codeAtom, code);
  seedNodesForCode(code);
}

/** Load the fixture project (+ the case's own files) the way the editor boots. */
export function seedWorld(c: Pick<CapabilityCase, 'files' | 'activeFile' | 'selection'>): Map<string, string> {
  const files = new Map<string, string>([...Object.entries(FIXTURE_FILES), ...Object.entries(c.files ?? {})]);
  resetProjectFS(new Map(files));
  store.set(componentEditorFileAtom, null);
  store.set(cmsEditorOpenAtom, false);
  store.set(cmsEditorCollectionAtom, null);
  const active = c.activeFile ?? HOME;
  // What the editor's own flush does (useMutationQueueLifecycle): write the
  // file AND publish the code to the store, so the node snapshot the NEXT tool
  // reads is derived from what the previous one wrote. Without the atom set,
  // a run of calls saw the project as it was before the first call.
  initMutationQueue(projectFS.readFile(active) ?? '', (flushed) => {
    projectFS.writeFile(store.get(activeFilePathAtom), flushed);
    store.set(codeAtom, flushed);
    bumpProjectVersion();
    store.set(projectVersionAtom, (v) => v + 1);
  });
  activate(active);
  store.set(projectVersionAtom, (v) => v + 1);
  store.set(selectedIdsAtom, c.selection ?? []);
  return files;
}

function replyText(content: unknown[]): string {
  return (content as { type?: string; text?: string }[]).map((b) => (b?.type === 'text' ? b.text ?? '' : '')).join('\n');
}

/** Run one case. Never throws: every problem is a line in `failures`. */
export async function runCase(c: CapabilityCase): Promise<CaseResult> {
  const failures: string[] = [];
  if (c.status === 'missing') return { id: c.id, ok: true, failures };

  const before = seedWorld(c);
  const replies: CaseWorld['replies'] = [];
  const runId = `cap-${c.id}`;
  agentRunStart({ runId });
  try {
    for (const call of c.calls ?? []) {
      if (!findTool(call.tool)) { failures.push(`tool "${call.tool}" is not registered`); continue; }
      const r = await agentToolCall({ name: call.tool, input: resolveRefs(call.args, replies), runId });
      const text = replyText(r.content);
      let data: any = null;
      try { data = JSON.parse(text); } catch { /* prose reply */ }
      replies.push({ tool: call.tool, isError: r.isError, text, data });
      if (r.isError && !c.allowFailedCalls) failures.push(`${call.tool} failed: ${text.slice(0, 400)}`);
    }
    flushNow();
  } catch (err) {
    failures.push(`threw: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    try { agentRunEnd({ runId }); } catch { /* the checkpoint is not what is under test */ }
  }

  const changed = projectFS.listFiles('').filter((p) => projectFS.readFile(p) !== (before.get(p) ?? null));
  for (const p of before.keys()) if (!projectFS.exists(p) && !changed.includes(p)) changed.push(p);

  // VALID — every changed source file passes the oracle for its kind.
  const allowed = new Set(c.allowViolations ?? []);
  for (const path of changed) {
    const code = projectFS.readFile(path);
    if (code == null) continue;
    const kind = kindOf(path, code);
    if (!kind) continue;
    // Files the BUILDER materializes for a feature (the FormSubmit / Spinner
    // masters a form drop ships) are its own hand-written runtime, not the
    // agent's output — they are exempt from the generated-code rules exactly
    // as the editor's own drop path never gates them.
    if (isBuilderRuntimeFile(code)) continue;
    let violations: OracleViolation[] = [];
    try { violations = checkFile(code, { kind, path }); } catch (err) { failures.push(`oracle threw on ${path}: ${String(err)}`); }
    // Only what the case INTRODUCED: the fixture is kept clean by its own test.
    const baseline = new Set((before.get(path) ? safeCheck(before.get(path)!, kind, path) : []).map((v) => v.code));
    for (const v of violations) {
      if (allowed.has(v.code) || baseline.has(v.code)) continue;
      failures.push(`oracle ${v.code} in ${path}: ${v.message.slice(0, 240)}`);
    }
  }

  // INTENDED — the effect is really there.
  if (failures.length === 0 && c.expect) {
    const world: CaseWorld = {
      read: (path) => projectFS.readFile(path),
      nodes: (path = c.activeFile ?? HOME) => parseJSXToNodes(projectFS.readFile(path) ?? ''),
      node: (id, path = c.activeFile ?? HOME) => {
        const n = parseJSXToNodes(projectFS.readFile(path) ?? '').get(id);
        if (!n) throw new Error(`node "${id}" not found in ${path}`);
        return n;
      },
      tag: (id, path = c.activeFile ?? HOME) => openingTag(projectFS.readFile(path) ?? '', id),
      json: (path) => JSON.parse(projectFS.readFile(path) ?? 'null'),
      replies,
      changed,
    };
    try { c.expect(world); } catch (err) { failures.push(`effect: ${err instanceof Error ? err.message : String(err)}`); }
  }
  return { id: c.id, ok: failures.length === 0, failures };
}

/** A master the builder writes from its own generator (`@formsubmit-gen`,
 *  `@spinner-gen`, …) — stamped in its header comment. */
const isBuilderRuntimeFile = isBuilderMaterializedFile;

/**
 * `"$key"` in a call's args reads `key` from the LATEST earlier reply whose
 * data carries it — the id a tool returned (`$control`, `$node_id`, `$button`)
 * feeds the next call the way the model would read it from the result.
 */
function resolveRefs(args: Record<string, unknown>, replies: CaseWorld['replies']): Record<string, unknown> {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string' && /^\$[a-z_]+$/.test(v)) {
      const key = v.slice(1);
      for (let i = replies.length - 1; i >= 0; i--) {
        const d = replies[i].data;
        if (d && typeof d === 'object' && d[key] != null) return d[key];
      }
      throw new Error(`no earlier reply carried "${key}" for ${v}`);
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(args) as Record<string, unknown>;
}

function safeCheck(code: string, kind: FileKind, path: string): OracleViolation[] {
  try { return checkFile(code, { kind, path }); } catch { return []; }
}
