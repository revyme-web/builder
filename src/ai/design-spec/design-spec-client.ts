// design-spec/design-spec-client.ts — browser-side loop for the design-component
// spec agent. The SERVER owns the prompt + schema + Gemini; the BROWSER owns the
// engine: it parses the current component into a bundle, asks the server for a new
// bundle, then validates → compiles → resolve-checks locally and applies — or
// bounces the violations back for a retry. A bundle that can't pass the gates is
// NEVER committed (worst case: no change + a message).
//
// v1 is depth-1: the entry component is parsed from its file; nested children are
// referenced as instances (not deep-parsed). New child components the model creates
// are compiled to fresh files.

import { trace } from '@/shared/debug-trace';
import { projectFS } from '@/code/project/project-fs';
import { modifyProjectFile } from '@/code/project/modify-file';
import { setForceRender, flushNow } from '@/code/mutation/mutation-queue';
import { checkFile } from '@/code/oracle/check-file';
import { isCodeComponentSource } from '@/code/oracle/checks/shared';
import { buildComponentRegistry } from '@/code/components/component-registry';
import { parseComponentSpec } from '@/code/components/component-spec/parse';
import { validateBundle } from '@/code/components/component-spec/validate';
import { compileBundle } from '@/code/components/component-spec/compile';
import { resolveCheck } from '@/code/components/component-spec/resolve-check';
import type { ComponentBundle, Violation } from '@/code/components/component-spec/types';

const AI_SERVICE_URL = import.meta.env.VITE_AI_SERVICE_URL || 'http://localhost:8082';
const MAX_ATTEMPTS = 3;

export interface DesignSpecEditRequest {
  prompt: string;
  activeFilePath: string;
  selectedNodeIds?: string[];
  workspaceId?: string;
}

export interface DesignSpecEditResult {
  success: boolean;
  /** Files written: their paths. */
  written?: string[];
  /** Why it could not be committed (after retries) — surface to the user. */
  error?: string;
  violations?: Violation[];
  attempts: number;
}

export async function runDesignSpecEdit(req: DesignSpecEditRequest): Promise<DesignSpecEditResult> {
  const { activeFilePath, prompt, selectedNodeIds = [], workspaceId } = req;
  trace.action('design-spec:start', { activeFilePath, prompt: prompt.slice(0, 80) });

  const code = projectFS.readFile(activeFilePath);
  if (!code) return { success: false, error: `File not found: ${activeFilePath}`, attempts: 0 };

  const registry = buildComponentRegistry(projectFS);
  const known = new Set(registry.keys());
  const entryName = basename(activeFilePath);

  // Build the starting bundle from the current file (depth-1).
  const currentBundle: ComponentBundle = {
    entry: entryName,
    components: [parseComponentSpec(code, entryName)],
  };

  let violations: Violation[] = [];
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    trace.action('design-spec:turn', { attempt });

    const res = await fetch(`${AI_SERVICE_URL}/api/design-spec/turn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt,
        activeFile: activeFilePath,
        selectedNodeIds,
        currentBundle,
        violations: violations.length ? violations.map((v) => ({ code: v.code, message: v.message })) : undefined,
        knownComponents: [...known],
        workspaceId,
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      return { success: false, error: err.error || `Request failed: ${res.status}`, attempts: attempt };
    }
    const data = await res.json();
    if (!data.success) return { success: false, error: data.error || 'turn failed', attempts: attempt };

    const bundle = data.bundle as ComponentBundle;

    // gate 2 — semantic validate
    violations = validateBundle(bundle, known);
    if (violations.length) {
      trace.action('design-spec:validate-failed', { attempt, count: violations.length, violations: violations.map((v) => `[${v.code}] ${v.elementId ?? v.variant ?? ''} ${v.message}`) });
      continue;
    }

    // compile + gate 3 — resolve-check against the real pipeline
    const files = compileBundle(bundle);
    violations = resolveCheck(files);
    if (violations.length) {
      trace.action('design-spec:resolve-failed', { attempt, count: violations.length, violations: violations.map((v) => `[${v.code}] ${v.elementId ?? v.variant ?? ''} ${v.message}`) });
      continue;
    }

    // commit — atomic-ish: write every file, then one render.
    // ORACLE FENCE (2026-08-11): this client is dormant (no UI caller) but the
    // commit is one rewiring away from being an ungated writer. Every file
    // must pass the same checkFile the submit gate runs before it lands.
    const written: string[] = [];
    const oracleBlocked: string[] = [];
    for (const f of files) {
      const path = resolveWritePath(f.specName, f.internalName, registry);
      const kind = isCodeComponentSource(f.code) ? 'code-component' as const : 'component' as const;
      const vs = checkFile(f.code, { kind, path });
      if (vs.length > 0) {
        oracleBlocked.push(`${path}: ${vs.slice(0, 2).map((x) => x.code).join(', ')}`);
        continue;
      }
      if (projectFS.readFile(path) != null) modifyProjectFile(path, () => f.code);
      else projectFS.writeFile(path, f.code);
      written.push(path);
    }
    if (oracleBlocked.length > 0) {
      trace.error('design-spec:oracle-blocked', { blocked: oracleBlocked });
      violations = oracleBlocked.map((b) => ({ code: 'ORACLE_BLOCKED', message: b } as (typeof violations)[number]));
      continue;
    }
    setForceRender();
    flushNow();
    trace.action('design-spec:committed', { attempt, written });
    return { success: true, written, attempts: attempt };
  }

  trace.action('design-spec:gave-up', { count: violations.length, violations: violations.map((v) => `[${v.code}] ${v.message}`) });
  // Show the user WHAT kept failing, not just that it failed — the first
  // violations are usually the story (the rest repeat the same pattern).
  const detail = violations.slice(0, 3).map((v) => v.message).join(' · ');
  return {
    success: false,
    error: `Could not produce a component that resolves after ${MAX_ATTEMPTS} attempts.${detail ? ` Last failure: ${detail}` : ''}`,
    violations,
    attempts: MAX_ATTEMPTS,
  };
}

/** Existing component → its real file; new component → components/<internalName>.tsx. */
function resolveWritePath(specName: string, internalName: string, registry: Map<string, { filePath: string }>): string {
  const existing = registry.get(specName);
  if (existing) return existing.filePath;
  return `components/${internalName}.tsx`;
}

function basename(path: string): string {
  return (path.split('/').pop() ?? path).replace(/\.tsx?$/, '');
}
