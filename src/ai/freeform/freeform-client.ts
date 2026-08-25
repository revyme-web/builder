// freeform/freeform-client.ts — browser-side loop for freeform+oracle generation.
//
// The SERVER owns the seed prompt + Gemini (ai-generator/src/freeform.ts); the
// BROWSER owns the gates: it sends the request, runs the returned file through
// the oracle (checkFile), and bounces the batched violations back until the
// file passes — then (and only then) writes it to the project. A file that
// can't pass the gates is NEVER committed (worst case: no change + a message).
//
// Hardening learned from the design-spec client's bugs (2026-06-09): per-attempt
// timeout, AbortController, and an isStillActive guard so a result never lands
// on (or saves under) a different file after the user switches away.

import { trace } from '@/shared/debug-trace';
import { projectFS } from '@/code/project/project-fs';
import { modifyProjectFile } from '@/code/project/modify-file';
import { isLayoutFile, listPageFiles } from '@/code/project/active-file-store';
import { setForceRender, flushNow, syncImports } from '@/code/mutation/mutation-queue';
import { pushHistoryImmediate } from '@/code/mutation/history';
import { ensureCursorPortalInLayout } from '@/code/generation/cursor-gen';
import { ensureFormRouteFile } from '@/code/generation/form-gen';
import { ensureLayoutFile } from '@/code/generation/metadata-gen';
import { ensureLayoutRootOnComponentRoot } from '@/code/components/component-ops';
import { getPresetTokens } from '@/code/project/preset-ops';
import { checkFile, ensureNodeDimensions, type FileKind, type OracleViolation } from '@/code/oracle/check-file';
import { isCodeComponentSource } from '@/code/oracle/checks/shared';
import { checkSubmitPath, checkPreservation, checkComponentCompat, checkTokenRefs, type SurfaceFile } from './turn-guards';
import { compileCodeComponent } from '@/canvas/code-component-runtime';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const AI_SERVICE_URL = import.meta.env.VITE_AI_SERVICE_URL || 'http://localhost:8082';
const MAX_ATTEMPTS = 3;
// Sized against the SERVER's budget, not against a guess at "reasonable".
// A whole-file rewrite of a big page can exceed the model's output ceiling,
// in which case the provider resumes and concatenates (see the continuation
// loop in ai-generator/src/providers/openrouter.ts) — so one attempt is now
// several model calls and minutes of real work. The old 120s aborted a live
// 116KB rewrite 3.6 SECONDS before the server had an answer, showed "The
// request timed out.", and still billed all three attempts (2026-08-25).
//
// The ladder, outermost last: server gives up at 280s with a readable error,
// this fires at 295s so that error actually arrives, nginx 504s at 300s
// (proxy_read_timeout on the /api/(freeform|…) block). Raising this past 300s
// buys nothing until nginx moves too.
const ATTEMPT_TIMEOUT_MS = 295_000;

export interface FreeformEditRequest {
  prompt: string;
  activeFilePath: string;
  kind: Extract<FileKind, 'page' | 'component'>;
  history?: Array<{ role: string; content: string }>;
  workspaceId?: string;
  /** OpenRouter model slug from the Vibe model select. Optional — the server
   *  clamps it to its catalog and falls back to the default when absent. */
  model?: string;
  signal?: AbortSignal;
  /** Re-checked before every apply/bounce — false means the user moved on. */
  isStillActive?: () => boolean;
  /** Progress callback per attempt: violations of the attempt that just failed. */
  onAttempt?: (attempt: number, violations: OracleViolation[]) => void;
}

export interface FreeformEditResult {
  success: boolean;
  attempts: number;
  /** Model's one-line explanation (on success). */
  text?: string;
  error?: string;
  violations?: OracleViolation[];
  /** All file paths written on success (multi-file turns create components too). */
  written?: string[];
  usage?: { inputTokens: number; outputTokens: number; durationMs: number };
}

export interface TurnFile { path: string; kind: 'page' | 'component'; code: string }

/** One short line per violation — the bounce payload the server forwards. */
export function formatBounce(violations: OracleViolation[]): Array<{ code: string; message: string }> {
  return violations.map((v) => ({ code: v.code, message: v.message }));
}

/**
 * THE gate, shared by the freeform loop and the MCP bridge: remap phantom
 * page paths, judge every file by its own kind's rules, and verify that every
 * '@/components/X' import resolves to the project or to this same batch.
 *
 * `activePagePath` — the page the user is on; a page-kind file whose path
 * matches nothing in the project can only MEAN that page, so it's remapped
 * instead of becoming a phantom file (live failure 2026-06-10). Pass null
 * when there is no active page (e.g. MCP submit while a component is open) —
 * then an unknown page path is a violation instead of a silent remap.
 */
export function gateTurnFiles(
  rawFiles: TurnFile[],
  activePagePath: string | null,
): { files: TurnFile[]; violations: OracleViolation[] } {
  const files = rawFiles.map((f) => {
    if (f.kind === 'page' && f.path !== activePagePath && projectFS.readFile(f.path) == null) {
      if (activePagePath) {
        trace.action('freeform:remap-phantom-page-path', { from: f.path, to: activePagePath });
        return { ...f, path: activePagePath };
      }
    }
    return f;
  });

  // The EFFECTIVE page surfaces for cross-file checks: batch versions win over
  // projectFS, so a batch updating a component AND its consumers resolves clean.
  const batchByPath = new Map(files.map((f) => [f.path, f.code]));
  const effectiveSurfaces = (): SurfaceFile[] => {
    const layoutClients = projectFS.listFiles().filter((p) => p.endsWith('LayoutClient.tsx'));
    return [...listPageFiles(), ...layoutClients].map((p) => ({
      path: p,
      code: batchByPath.get(p) ?? projectFS.readFile(p) ?? '',
    }));
  };

  // Known design tokens (app/globals.css) — var(--x) refs are checked per file.
  const knownTokens = new Set(getPresetTokens().map((t) => t.name));

  const violations: OracleViolation[] = files.flatMap((f) => {
    const tag = (vs: OracleViolation[]) =>
      files.length > 1 ? vs.map((x) => ({ ...x, message: `[${f.path}] ${x.message}` })) : vs;

    // Path discipline first — an unwritable path makes content checks moot.
    const pathVs = checkSubmitPath(f.path, f.kind);
    if (pathVs.length > 0) return tag(pathVs);

    if (f.kind === 'page' && projectFS.readFile(f.path) == null) {
      return [{
        code: 'PHANTOM_PAGE_PATH', tier: 3,
        message: `[${f.path}] no page exists at this path. Pages are never created here — use the EXACT path of an existing page (read the project context to see them).`,
      } satisfies OracleViolation];
    }
    // Layout files are templates: page dialect + the {children} slot invariant.
    // The kind is derived from the PATH, not the model's declaration — a model
    // can't dodge the slot check by calling the file a plain page. Component
    // files carrying an @controls block are CODE COMPONENTS: black-box
    // JS edited via controls, judged by the code component rules (no per-element
    // data-id requirement inside).
    const kind: FileKind = f.kind === 'component'
      ? (isCodeComponentSource(f.code) ? 'code-component' : 'component')
      : isLayoutFile(f.path) ? 'template' : 'page';
    // Data-ids already present in the LIVE (pre-submit) version of this file.
    // New-node-only rules (PIN_ABSOLUTE_NODE) use this to flag ONLY nodes the
    // model is adding this turn — never pre-existing builder content (which may
    // legitimately use dynamic pinning). A brand-new file has no prior version,
    // so the set is empty and every node counts as new (all MCP-authored).
    const prevCode = projectFS.readFile(f.path);
    const existingDataIds = new Set<string>();
    // JSX attributes only — the negative lookbehind excludes `[data-id="…"]`
    // CSS selectors in the <style> block, which used to mark ids as
    // "pre-existing" even when the ELEMENT never existed (an id that only
    // ever appeared in a stale band rule exempted the model's brand-new node
    // from every new-node rule, 2026-08-11).
    if (prevCode) for (const m of prevCode.matchAll(/(?<!\[)data-id="([^"]+)"/g)) existingDataIds.add(m[1]);
    let vs = [...checkFile(f.code, { kind, path: f.path, existingDataIds })];
    // ── GRANDFATHERING ────────────────────────────────────────────────────
    // The oracle grows rules; legacy files carry violations they were built
    // with. Judging an EDIT by the whole file would brick AI editing on any
    // page with pre-existing quirks ("fix all history before touching
    // anything"). So the gate blocks only what this edit ADDS: a violation
    // that already existed in the previous on-disk version — same rule code
    // on the same element (or, for element-less rules, up to the same count)
    // — passes through. A brand-new file has no previous version and is
    // judged in full.
    if (prevCode) {
      const prevKind: FileKind = f.kind === 'component'
        ? (isCodeComponentSource(prevCode) ? 'code-component' : 'component')
        : isLayoutFile(f.path) ? 'template' : 'page';
      const oldVs = checkFile(prevCode, { kind: prevKind, path: f.path });
      const oldKeyed = new Set(oldVs.filter((o) => o.elementId).map((o) => `${o.code}::${o.elementId}`));
      const oldCounts = new Map<string, number>();
      for (const o of oldVs) if (!o.elementId) oldCounts.set(o.code, (oldCounts.get(o.code) ?? 0) + 1);
      const kept: typeof vs = [];
      const used = new Map<string, number>();
      let grandfathered = 0;
      for (const cur of vs) {
        if (cur.elementId && oldKeyed.has(`${cur.code}::${cur.elementId}`)) { grandfathered++; continue; }
        if (!cur.elementId) {
          const allowance = oldCounts.get(cur.code) ?? 0;
          const usedSoFar = used.get(cur.code) ?? 0;
          if (usedSoFar < allowance) { used.set(cur.code, usedSoFar + 1); grandfathered++; continue; }
        }
        kept.push(cur);
      }
      if (grandfathered > 0) {
        trace.action('oracle:grandfathered-violations', { path: f.path, grandfathered, enforced: kept.length });
      }
      vs = kept;
    }
    if (f.code.includes('var(')) vs.push(...checkTokenRefs(f.code, knownTokens));

    // CODE COMPONENT COMPILE GATE — checkFile validates dialect/syntax, but a code
    // code component can still fail to COMPILE/RENDER at runtime (undefined
    // identifier, a transform the canvas applies, a bad export) — the dialect
    // tier can't see that, so a non-rendering code component used to commit and only
    // blow up in the preview ("Compilation returned null", "X is not defined").
    // Compile it here through the SAME path the canvas/preview uses and bounce
    // on null/throw. Skip when there's already a syntax error (compile is moot).
    if (kind === 'code-component' && vs.every((x) => x.tier !== 1)) {
      const compName = (f.path.split('/').pop() || 'Component').replace(/\.tsx?$/, '');
      try {
        // Compile the POST-import-sync form — exactly what commitTurnFiles will
        // write (modifyProjectFile runs the same syncImports). This catches both
        // authored failures AND import-sync-induced ones (e.g. a dropped named
        // React import like `Children` → "Children is not defined" at runtime).
        const finalCode = syncImports(f.code);
        const Comp = compileCodeComponent(finalCode, compName, { previewMode: false, skipCache: true });
        if (!Comp) {
          vs.push({
            code: 'CODE_COMPONENT_COMPILE_FAILED', tier: 3,
            message: `This code component compiles to null — no default component was produced. It MUST end with "export default withResponsiveProps(${compName});" and the function must return JSX.`,
          });
        } else {
          // Smoke-RENDER with defaults + no children. Module-eval alone misses
          // render-time crashes (an undefined identifier USED in the body, e.g.
          // a dropped `Children` import → "Children is not defined"). Effects are
          // skipped in server render, so rAF loops don't run. A code component must render
          // its empty/default state without throwing.
          renderToStaticMarkup(createElement(Comp));
        }
      } catch (err) {
        vs.push({
          code: 'CODE_COMPONENT_COMPILE_FAILED', tier: 3,
          message: `This code component fails to COMPILE/RENDER: ${(err as Error).message || String(err)}. A dialect-clean code component can still crash at runtime (undefined identifier, bad import, a reference the canvas strips). Use React.Children/React.memo (not bare named imports the import-sync may drop), define every identifier, and keep all logic inside the component. The canvas compiles it exactly this way.`,
        });
      }
    }

    // Stateful guards — judged against the file being overwritten.
    const oldCode = projectFS.readFile(f.path);
    if (oldCode != null) {
      vs.push(...checkPreservation(oldCode, f.code));
      if (f.kind === 'component') {
        vs.push(...checkComponentCompat(f.path, oldCode, f.code, effectiveSurfaces()));
      }
    }
    return tag(vs);
  });

  // Hallucinated imports: every '@/components/X' import in a page file must
  // resolve to an existing project file OR a file created in this same batch.
  const batchPaths = new Set(files.map((f) => f.path));
  for (const f of files) {
    for (const m of f.code.matchAll(/from\s+['"]@\/components\/(\w+)['"]/g)) {
      const compPath = `components/${m[1]}.tsx`;
      if (!batchPaths.has(compPath) && projectFS.readFile(compPath) == null) {
        violations.push({
          code: 'COMPONENT_IMPORT_MISSING', tier: 3,
          message: `[${f.path}] imports '@/components/${m[1]}' but no such component exists in the project or in this batch. Create components/${m[1]}.tsx as a second file in this response (kind "component"), or import an existing component.`,
        });
      }
    }
    // CMS data imports: collections are never created by submit — they come
    // from revyme_manage_cms (or the editor). An import of a nonexistent
    // collection renders an empty list with zero errors.
    for (const m of f.code.matchAll(/from\s+['"]@\/cms\/([a-z0-9-]+)\.json['"]/g)) {
      if (projectFS.readFile(`cms/${m[1]}.json`) == null) {
        violations.push({
          code: 'CMS_IMPORT_MISSING', tier: 3,
          message: `[${f.path}] imports '@/cms/${m[1]}.json' but no collection "${m[1]}" exists. Collections are never created by submit — create it FIRST via revyme_manage_cms (create_collection + add_field + add_item), then resubmit. Existing collections are listed in the project context.`,
        });
      }
    }
  }

  return { files, violations };
}

/** All-or-nothing batch commit + render flush. Call ONLY after a clean gate. */
export function commitTurnFiles(files: TurnFile[]): string[] {
  const written: string[] = [];
  for (const f of files) {
    // Inject explicit width/height: 'auto' into any sizeless normal node so the COMMITTED
    // source always carries dimensions — make-component, resize, and per-viewport sizing
    // need a real value, but the editor otherwise falls back to auto WITHOUT writing it,
    // leaving the source sizeless. A builder-owned side-effect at commit, exactly like
    // syncImports. Code components (black-box JS, no per-element nodes) are skipped.
    const k: FileKind = f.kind === 'component'
      ? (isCodeComponentSource(f.code) ? 'code-component' : 'component')
      : isLayoutFile(f.path) ? 'template' : 'page';
    let code = k === 'code-component' ? f.code : ensureNodeDimensions(f.code);
    if (code !== f.code) trace.action('freeform:inject-node-dimensions', { path: f.path });
    // Fixed-header safety: a design-component whose INSTANCE is later set
    // position:fixed/sticky "slides in" on navigation unless its layout-animated
    // root carries `layoutScroll={(CHECK)}` + `layout={(CHECK) ? "size" : true}`.
    // Normalize it in for AI-submitted components (idempotent, motion roots only) —
    // the editor injects the same via ensureLayoutRootOnComponentRoot on the fixed
    // toggle; doing it at commit guarantees a Header can never ship sliding.
    if (k === 'component') {
      const fixed = ensureLayoutRootOnComponentRoot(code);
      if (fixed !== code) { code = fixed; trace.action('freeform:inject-fixed-header-layoutscroll', { path: f.path }); }
    }
    // VALIDATED-BYTES check: the two mutators above run AFTER the gate, so the
    // committed source is not byte-identical to what was validated. Re-check
    // the final form and trace any drift loudly — a violation here means OUR
    // mutator (not the model) produced off-dialect output, which is a bug to
    // fix in the mutator, never something to silently ship dark.
    if (code !== f.code) {
      try {
        const driftVs = checkFile(code, { kind: k, path: f.path });
        const beforeVs = checkFile(f.code, { kind: k, path: f.path });
        const beforeKeys = new Set(beforeVs.map((x) => `${x.code}::${x.elementId ?? ''}`));
        const introduced = driftVs.filter((x) => !beforeKeys.has(`${x.code}::${x.elementId ?? ''}`));
        if (introduced.length > 0) {
          trace.error('oracle:post-mutation-drift', {
            path: f.path, codes: introduced.map((x) => x.code),
          });
        }
      } catch { /* diagnostics only — never block the commit on the checker */ }
    }
    if (projectFS.readFile(f.path) != null) modifyProjectFile(f.path, () => code);
    else projectFS.writeFile(f.path, code);
    written.push(f.path);
  }

  // Component cursors need <CursorPortal /> mounted once in app/layout.tsx.
  // layout.tsx is a PROTECTED_PATH the model can never write, so the gate
  // mounts it itself — the exact flow CursorTool's mountCursorPortal() uses
  // (create-if-missing + idempotent ensure). Without this an AI-written
  // {...withCursor(…)} renders nothing on the live site.
  if (files.some((f) => f.code.includes('{...withCursor('))) {
    if (!projectFS.exists('app/layout.tsx')) {
      projectFS.writeFile('app/layout.tsx', ensureLayoutFile());
      trace.action('freeform:create-layout-for-cursor-portal', {});
    }
    modifyProjectFile('app/layout.tsx', (c) => ensureCursorPortalInLayout(c));
    trace.action('freeform:cursor-portal-ensured', {});
  }

  // AI-authored forms POST to the same-origin /api/form relay, but that route
  // file is only materialized by the EDITOR's form flows (form drop / Send To
  // write). Ensure it at commit too, or an MCP-submitted form 404s on the
  // published site until the user happens to touch the Form tool.
  if (files.some((f) => f.code.includes('data-form='))) {
    ensureFormRouteFile();
    trace.action('freeform:form-route-ensured', {});
  }

  setForceRender();
  flushNow();
  // The gate's direct writes bypass the mutation queue, and an EMPTY-queue
  // flushNow() never fires onFlush → pushHistory — so without this an AI
  // commit is not undoable until the user's next edit lumps it in. The
  // snapshot-diff push captures the whole batch as ONE undo step.
  pushHistoryImmediate('');
  trace.action('freeform:committed-batch', { written });
  return written;
}

export async function runFreeformEdit(req: FreeformEditRequest): Promise<FreeformEditResult> {
  const { prompt, activeFilePath, kind, history = [], workspaceId, model, signal, isStillActive = () => true, onAttempt } = req;
  trace.action('freeform:start', { activeFilePath, kind, model, prompt: prompt.slice(0, 80) });

  const currentCode = projectFS.readFile(activeFilePath);
  if (currentCode == null) return { success: false, attempts: 0, error: `File not found: ${activeFilePath}` };

  let previousAttempt: string | undefined;
  let violations: OracleViolation[] = [];
  const usage = { inputTokens: 0, outputTokens: 0, durationMs: 0 };

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    trace.action('freeform:turn', { attempt, violations: violations.map((v) => v.code) });

    // per-attempt timeout composed with the caller's abort signal
    const timeout = AbortSignal.timeout(ATTEMPT_TIMEOUT_MS);
    const composed = signal ? AbortSignal.any([signal, timeout]) : timeout;

    let res: Response;
    try {
      res = await fetch(`${AI_SERVICE_URL}/api/freeform/turn`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: composed,
        body: JSON.stringify({
          prompt,
          kind,
          currentCode,
          // the file's REAL path — without it the model invents one and the
          // page update lands on a phantom file (live failure 2026-06-10)
          currentPath: activeFilePath,
          previousAttempt,
          violations: violations.length ? formatBounce(violations) : undefined,
          history,
          workspaceId,
          model,
        }),
      });
    } catch (err) {
      if (signal?.aborted) return { success: false, attempts: attempt, error: 'Stopped.' };
      return { success: false, attempts: attempt, error: timeout.aborted ? 'The request timed out.' : String((err as Error).message ?? err) };
    }

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      return { success: false, attempts: attempt, error: err.error || `Request failed: ${res.status}` };
    }
    const data = await res.json();
    if (!data.success) return { success: false, attempts: attempt, error: data.error || 'turn failed' };

    usage.inputTokens += data.usage?.inputTokens ?? 0;
    usage.outputTokens += data.usage?.outputTokens ?? 0;
    usage.durationMs += data.usage?.durationMs ?? 0;

    // Normalize the turn's files (multi-file protocol; empty path = active file),
    // then run the shared gate (phantom-page remap + per-kind oracle + import
    // resolution) — same gatekeeper the MCP bridge uses.
    const rawFiles: TurnFile[] = (data.files as TurnFile[] | undefined)?.length
      ? (data.files as TurnFile[]).map((f) => ({ ...f, path: f.path || activeFilePath }))
      : [{ path: activeFilePath, kind, code: data.code as string }];
    const gated = gateTurnFiles(rawFiles, kind === 'page' ? activeFilePath : null);
    const files = gated.files;
    violations = gated.violations;

    if (violations.length > 0) {
      trace.action('freeform:violations', {
        attempt,
        count: violations.length,
        violations: violations.map((x) => `[${x.code}] ${x.message}`),
      });
      previousAttempt = files.length > 1
        ? files.map((f) => `--- ${f.path} (${f.kind}) ---\n${f.code}`).join('\n\n')
        : files[0].code;
      onAttempt?.(attempt, violations);
      continue;
    }

    // ── commit: all-or-nothing across the batch ──
    if (!isStillActive()) {
      trace.action('freeform:discard-after-file-switch', { activeFilePath });
      return { success: false, attempts: attempt, error: 'Discarded — you switched files while generating.' };
    }
    const written = commitTurnFiles(files);
    trace.action('freeform:committed', { activeFilePath, attempt, written });
    return { success: true, attempts: attempt, text: data.text, written, usage };
  }

  trace.action('freeform:gave-up', { count: violations.length, violations: violations.map((x) => x.code) });
  const detail = violations.slice(0, 3).map((x) => x.message).join(' · ');
  return {
    success: false,
    attempts: MAX_ATTEMPTS,
    error: `Could not produce a file that passes the checks after ${MAX_ATTEMPTS} attempts.${detail ? ` Last failures: ${detail}` : ''}`,
    violations,
    usage,
  };
}
