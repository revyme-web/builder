// src/ai/agent/tools/branches.ts
//
// Branches for the ONE agent — the reference builder's "agent branch": a big or risky piece
// of work happens on a copy of the project, main stays the publish truth, the
// user reviews the changes and applies them. The Branches panel's own moves
// (create from the workspace snapshot, switch = pointer move, review =
// per-node change rows, apply = 3-way merge through the oracle gate) as
// calls. A branch the run creates or enters becomes the run's branch: the lock
// follows it, so the tab cannot be moved out from under the run's writes.

import { z } from 'zod';
import { getDefaultStore } from 'jotai';
import type { AgentTool, AgentToolResult } from '@/ai/agent';
import { flushTool } from '@/ai/agent/workspace';
import { projectFS, projectVersionAtom, MAIN_BRANCH_ID } from '@/code/project/project-fs';
import { switchBranchFile } from '@/code/branching/switch-workspace';
import { createBranchAndSwitch } from '@/code/branching/create';
import { toBranchId } from '@/code/stores/branch-store';
import { applyBranch } from '@/code/branching/apply';
import { describeFileChanges } from '@/code/branching/describe-changes';
import { getBranchDrift } from '@/code/branching/update-branch';
import { agentRunFollowBranch } from '@/ai/agent/bridge-tools';
import { trace } from '@/shared/debug-trace';

const store = getDefaultStore();

function ok(data: unknown): AgentToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}
function fail(message: string): AgentToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}
const bump = (): void => { store.set(projectVersionAtom, (v) => v + 1); };

/** Files that differ between a branch and its base, with the per-node rows the review modal shows. */
export function branchChanges(branchId: string): { files: { path: string; status: 'added' | 'removed' | 'changed'; changes: string[] }[] } | null {
  const files = projectFS.readBranchFiles(branchId);
  const base = projectFS.readBranchBase(branchId);
  if (!files || !base) return null;
  const out: { path: string; status: 'added' | 'removed' | 'changed'; changes: string[] }[] = [];
  const paths = new Set([...files.keys(), ...base.keys()]);
  for (const path of [...paths].sort()) {
    const before = base.get(path) ?? null;
    const after = files.get(path) ?? null;
    if (before === after) continue;
    const status = before == null ? 'added' : after == null ? 'removed' : 'changed';
    const rows: string[] = [];
    if (/\.tsx$/.test(path) && before != null && after != null) {
      const d = describeFileChanges(before, after);
      for (const c of d.changes.slice(0, 12)) rows.push(`${c.kind} ${c.title}${c.props.length ? ': ' + c.props.map((p) => `${p.label} ${p.before || '—'} → ${p.after || '—'}`).join(', ') : ''}${c.moreProps ? ` (+${c.moreProps})` : ''}`);
      if (d.changes.length > 12) rows.push(`… ${d.changes.length - 12} more`);
    }
    out.push({ path, status, changes: rows });
  }
  return { files: out };
}

function describeBranches(): { id: string; active: boolean; status: string; parent: string | null; changed_files?: number }[] {
  return projectFS.listBranches().map((b) => ({
    id: b.id, active: b.active, status: b.status, parent: b.parentId,
    ...(b.id === MAIN_BRANCH_ID ? {} : { changed_files: branchChanges(b.id)?.files.length ?? 0 }),
  }));
}

// ─── list_branches ───────────────────────────────────────────────────────────

export const listBranchesTool: AgentTool = {
  name: 'list_branches',
  description: 'The project\'s branches and which one the editor is on. main is the version that publishes; a branch is a full copy of the project the user reviews and applies to main (Branches panel).',
  inputSchema: {},
  category: 'read',
  async execute() {
    return ok({ active: projectFS.getActiveBranchId(), branches: describeBranches() });
  },
};

// ─── create_branch ───────────────────────────────────────────────────────────

export const createBranchTool: AgentTool = {
  name: 'create_branch',
  description:
    'Create a BRANCH — a copy of the whole project as it is now — and switch the editor to it, so a big piece of work (a redesign, several sections or pages, anything the user wants to try) happens there and main stays untouched until they review and apply. ' +
    'Name it after the work ("pricing-redesign"), never the person. Every later tool call lands on the branch; end the run by saying it is ready to review in the Branches panel. Ask before creating one unless the user asked for a branch or the work is clearly large.',
  inputSchema: { name: z.string().describe('branch name, e.g. "Pricing redesign" → pricing-redesign') },
  category: 'semantic',
  async execute(args, ctx) {
    ctx.ensureCheckpoint();
    flushTool(ctx);
    const created = createBranchAndSwitch(String(args.name));
    if ('error' in created) return fail(created.error);
    const id = created.id;
    agentRunFollowBranch(id);
    bump();
    trace.action('agent-tool:create_branch', { id });
    return ok({ branch: id, active: true, from: projectFS.listBranches().find((b) => b.id === id)?.parentId ?? MAIN_BRANCH_ID, note: 'every write from now on lands on this branch; main is untouched until the user applies it' });
  },
};

// ─── switch_branch ───────────────────────────────────────────────────────────

export const switchBranchTool: AgentTool = {
  name: 'switch_branch',
  description: 'Move the editor (and every following write) to an existing branch, or back to "main". The user sees the branch on the canvas right away.',
  inputSchema: { name: z.string().describe('branch id from list_branches, or "main"') },
  category: 'semantic',
  async execute(args, ctx) {
    const id = String(args.name).trim() === MAIN_BRANCH_ID ? MAIN_BRANCH_ID : toBranchId(String(args.name));
    if (id === projectFS.getActiveBranchId()) return ok({ branch: id, active: true, note: 'already there' });
    ctx.ensureCheckpoint();
    flushTool(ctx);
    const refusal = switchBranchFile(id);
    if (refusal) return fail(refusal);
    agentRunFollowBranch(id);
    bump();
    trace.action('agent-tool:switch_branch', { id });
    return ok({ branch: id, active: true });
  },
};

// ─── review_branch ───────────────────────────────────────────────────────────

export const reviewBranchTool: AgentTool = {
  name: 'review_branch',
  description: 'What a branch changed against the version it was cut from — per file, with the same per-node rows the Branches panel\'s Review shows ("Hero: font size 14px → 18px") — and whether main moved since (drift the apply must merge). Default: the active branch.',
  inputSchema: { name: z.string().optional() },
  category: 'read',
  async execute(args) {
    const id = args.name ? toBranchId(String(args.name)) : projectFS.getActiveBranchId();
    if (id === MAIN_BRANCH_ID) return fail('main has nothing to review — it is the base. Pass a branch (list_branches).');
    const changes = branchChanges(id);
    if (!changes) return fail(`Unknown branch "${id}". Branches: ${projectFS.listBranches().map((b) => b.id).join(', ')}.`);
    const drift = getBranchDrift(id);
    return ok({ branch: id, ...changes, main_moved_since: drift.moved, ...(drift.moved ? { main_changed: drift.changedPaths } : {}), next: changes.files.length ? 'apply_branch when the user is happy (or they apply it from the Branches panel)' : 'nothing changed on this branch yet' });
  },
};

// ─── apply_branch ────────────────────────────────────────────────────────────

export const applyBranchTool: AgentTool = {
  name: 'apply_branch',
  description:
    'Apply a branch to main — the Branches panel\'s Apply: a 3-way merge with main, every merged file through the oracle, nothing written on a conflict or a refusal. ONLY when the user asked to apply / merge; never on your own after building. Applying does not publish. Afterwards the editor is on main (the branch is kept, now equal to main).',
  inputSchema: { name: z.string().optional().describe('branch id; default: the active branch') },
  category: 'semantic',
  async execute(args, ctx) {
    const id = args.name ? toBranchId(String(args.name)) : projectFS.getActiveBranchId();
    if (id === MAIN_BRANCH_ID) return fail('main cannot be applied onto itself — pass a branch.');
    if (!projectFS.readBranchFiles(id)) return fail(`Unknown branch "${id}".`);
    ctx.ensureCheckpoint();
    flushTool(ctx);
    const res = applyBranch(id);
    bump();
    trace.action('agent-tool:apply_branch', { id, status: res.status });
    if (res.status === 'conflicts') return fail(`${res.conflicts.length} file(s) conflict with main (${res.conflicts.map((c) => c.path).join(', ')}) — nothing was written. Tell the user: resolve on the branch (or in the Branches panel), then apply again.`);
    if (res.status === 'refused') return fail(`Apply was refused, nothing was written: ${res.reason ?? 'the merged files did not pass the oracle'}`);
    // applyBranch lands the editor on main; the run's lock follows.
    agentRunFollowBranch(MAIN_BRANCH_ID);
    return ok({ branch: id, applied: true, files: res.files, active: projectFS.getActiveBranchId(), note: 'main has the changes and the editor is on main; the site is NOT published — the user publishes when ready' });
  },
};

// ─── delete_branch ───────────────────────────────────────────────────────────

export const deleteBranchTool: AgentTool = {
  name: 'delete_branch',
  description: 'Discard a branch and everything on it (main is untouched). Only when the user asked to throw it away. The active branch is left first (the editor goes back to main).',
  inputSchema: { name: z.string() },
  category: 'semantic',
  async execute(args, ctx) {
    const id = toBranchId(String(args.name));
    if (id === MAIN_BRANCH_ID) return fail('main cannot be deleted.');
    if (!projectFS.readBranchFiles(id)) return fail(`Unknown branch "${id}".`);
    ctx.ensureCheckpoint();
    flushTool(ctx);
    if (projectFS.getActiveBranchId() === id) {
      const refusal = switchBranchFile(MAIN_BRANCH_ID);
      if (refusal) return fail(refusal);
      agentRunFollowBranch(MAIN_BRANCH_ID);
    }
    const refusal = projectFS.deleteBranch(id);
    if (refusal) return fail(refusal);
    bump();
    trace.action('agent-tool:delete_branch', { id });
    return ok({ deleted: id, active: projectFS.getActiveBranchId() });
  },
};

export const BRANCH_TOOLS: AgentTool[] = [listBranchesTool, createBranchTool, switchBranchTool, reviewBranchTool, applyBranchTool, deleteBranchTool];
