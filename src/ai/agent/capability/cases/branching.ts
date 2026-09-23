// Branches — the reference builder's "agent branch": big work on a copy, main untouched until
// the user reviews and applies. Every case runs the real ProjectFS branch
// maps, the real switch, the real 3-way apply through the oracle gate.
import type { CapabilityCase } from '../harness';
import { HOME, FIXTURE_FILES } from '../fixture';
import { projectFS } from '@/code/project/project-fs';

const must = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };

export const BRANCHING_CASES: CapabilityCase[] = [
  {
    id: 'branching/list', domain: 'branching', status: 'supported',
    feature: 'Know which branch the editor is on',
    ask: 'which branch am I on?',
    calls: [{ tool: 'list_branches', args: {} }],
    expect: (w) => must(w.replies[0].data?.active === 'main' && w.replies[0].data?.branches?.[0]?.id === 'main', 'main is not reported as the active branch'),
  },
  {
    id: 'branching/create-and-work', domain: 'branching', status: 'supported',
    feature: 'Create a branch for a big change and work on it; main stays untouched',
    ask: 'redesign the hero — do it on a branch',
    calls: [
      { tool: 'create_branch', args: { name: 'Hero redesign' } },
      { tool: 'set_text', args: { node_id: 'hero-title', text: 'A bolder hero' } },
      { tool: 'set_styles', args: { node_id: 'hero', styles: { backgroundColor: '#111827' } } },
      { tool: 'review_branch', args: {} },
    ],
    expect: (w) => {
      must(w.replies[0].data?.branch === 'hero-redesign' && w.replies[0].data?.active === true, `branch not created / not active: ${w.replies[0].text.slice(0, 200)}`);
      must(projectFS.getActiveBranchId() === 'hero-redesign', 'the editor did not switch to the branch');
      // The branch has the work; main (the publish truth) is byte-identical to the fixture.
      must(/A bolder hero/.test(projectFS.readBranchFile('hero-redesign', HOME) ?? ''), 'the edit did not land on the branch');
      must(projectFS.readBranchFile('main', HOME) === FIXTURE_FILES[HOME], 'main was touched by work on the branch');
      const review = w.replies[3].data;
      must(review?.branch === 'hero-redesign' && review?.files?.some((f: { path: string; changes: string[] }) => f.path === HOME && f.changes.length > 0), `review_branch does not describe the change: ${w.replies[3].text.slice(0, 300)}`);
      must(review?.main_moved_since === false, 'main should not have moved');
    },
  },
  {
    id: 'branching/apply', domain: 'branching', status: 'supported',
    feature: 'Apply a reviewed branch to main (through the oracle gate)',
    ask: 'apply the hero redesign branch to main',
    calls: [
      { tool: 'create_branch', args: { name: 'hero-redesign' } },
      { tool: 'set_text', args: { node_id: 'hero-title', text: 'A bolder hero' } },
      { tool: 'apply_branch', args: {} },
    ],
    expect: (w) => {
      must(w.replies[2].data?.applied === true, `apply failed: ${w.replies[2].text.slice(0, 300)}`);
      must(/A bolder hero/.test(projectFS.readBranchFile('main', HOME) ?? ''), 'main does not carry the applied change');
      must(projectFS.getActiveBranchId() === 'main' && w.replies[2].data?.active === 'main', 'apply should land the editor on main');
      must(projectFS.readBranchFile('hero-redesign', HOME) === projectFS.readBranchFile('main', HOME), 'the branch should now equal main');
    },
  },
  {
    id: 'branching/switch-and-delete', domain: 'branching', status: 'supported',
    feature: 'Switch between branches; throw one away',
    ask: 'go back to main and delete the experiment branch',
    calls: [
      { tool: 'create_branch', args: { name: 'experiment' } },
      { tool: 'set_text', args: { node_id: 'hero-title', text: 'Experiment' } },
      { tool: 'switch_branch', args: { name: 'main' } },
      { tool: 'delete_branch', args: { name: 'experiment' } },
      { tool: 'list_branches', args: {} },
    ],
    expect: (w) => {
      must(projectFS.readBranchFile('main', HOME) === FIXTURE_FILES[HOME], 'main changed');
      must(w.replies[3].data?.deleted === 'experiment', 'delete did not report');
      must(w.replies[4].data?.branches?.length === 1 && w.replies[4].data?.active === 'main', 'the branch is still listed');
    },
  },
  {
    id: 'branching/protect-main', domain: 'branching', status: 'supported',
    feature: 'main can neither be applied onto itself nor deleted; a duplicate branch name is refused',
    ask: '(safety) delete main / apply main / create main',
    calls: [
      { tool: 'delete_branch', args: { name: 'main' } },
      { tool: 'apply_branch', args: { name: 'main' } },
      { tool: 'create_branch', args: { name: 'main' } },
    ],
    allowFailedCalls: true,
    expect: (w) => {
      must(w.replies.every((r) => r.isError), 'one of the protections did not hold');
      must(projectFS.getActiveBranchId() === 'main' && projectFS.listBranches().length === 1, 'a branch was created anyway');
    },
  },
];
