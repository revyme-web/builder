// branching/describe-changes.ts — P8-UX: human-readable change rows
// (V1 property, V2 code — NOT V1's change-grouping.ts restored).
//
// Turns a before/after file pair into per-node rows: added / removed /
// moved / changed with human property labels (Font size, Color…) and
// before → after values. Pure (parse both sides, compare maps); unparseable
// sides yield an unparsed row instead of throwing — the review UI shows it
// as "couldn't be inspected", never silent.

import { parseJSXToNodes, type CanvasNode } from '@/code/parsing/parser';

/** Human labels for style/attr/text diffs (panel vocabulary). */
const PROP_LABELS: Record<string, string> = {
  fontSize: 'Font size', fontFamily: 'Font', color: 'Color', backgroundColor: 'Background',
  padding: 'Padding', margin: 'Margin', width: 'Width', height: 'Height',
  letterSpacing: 'Letter spacing', lineHeight: 'Line height', fontWeight: 'Font weight',
  borderRadius: 'Corner radius', border: 'Border', textAlign: 'Text align', position: 'Position',
  flexDirection: 'Direction', gap: 'Gap', opacity: 'Opacity', transform: 'Transform',
  textContent: 'Text', tag: 'Tag', name: 'Name', src: 'Image', alt: 'Alt text',
};

function labelOf(prop: string): string {
  return PROP_LABELS[prop] ?? prop.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
}

function trunc(v: string): string {
  return v.length > 60 ? `${v.slice(0, 57)}…` : v;
}

export interface PropChange {
  label: string;
  before: string;
  after: string;
}

export interface NodeChange {
  id: string;
  title: string;
  kind: 'added' | 'removed' | 'moved' | 'changed';
  props: PropChange[];
  moreProps: number;
}

export interface FileChangeDescription {
  changes: NodeChange[];
  /** True when a side failed to parse (row shows "couldn't be inspected"). */
  unparsed: boolean;
}

function safeParse(code: string | null): Map<string, CanvasNode> | null {
  if (code == null) return new Map();
  try {
    return parseJSXToNodes(code);
  } catch {
    return null;
  }
}

function nodeTitle(node: CanvasNode): string {
  return node.name || node.type || 'Untitled';
}

function diffProps(before: CanvasNode, after: CanvasNode): PropChange[] {
  const out: PropChange[] = [];
  if (before.type !== after.type) {
    out.push({ label: 'Tag', before: before.type, after: after.type });
  }
  if (before.textContent !== after.textContent) {
    out.push({ label: 'Text', before: trunc(before.textContent), after: trunc(after.textContent) });
  }
  const keys = new Set([...Object.keys(before.styles), ...Object.keys(after.styles)]);
  for (const k of keys) {
    const b = before.styles[k] ?? '';
    const a = after.styles[k] ?? '';
    if (b !== a) out.push({ label: labelOf(k), before: trunc(b), after: trunc(a) });
  }
  const bAttrs = before.attrs ?? {};
  const aAttrs = after.attrs ?? {};
  for (const k of new Set([...Object.keys(bAttrs), ...Object.keys(aAttrs)])) {
    const b = bAttrs[k] ?? '';
    const a = aAttrs[k] ?? '';
    if (b !== a) out.push({ label: labelOf(k), before: trunc(b), after: trunc(a) });
  }
  return out;
}

/** Describe per-node changes between two file versions (either may be null
 *  for add/remove-file). Deterministic order: removals, additions, moves,
 *  changes, each by title. */
export function describeFileChanges(beforeCode: string | null, afterCode: string | null): FileChangeDescription {
  const before = safeParse(beforeCode);
  const after = safeParse(afterCode);
  if (!before || !after) return { changes: [], unparsed: true };
  const removed: NodeChange[] = [];
  const added: NodeChange[] = [];
  const moved: NodeChange[] = [];
  const changed: NodeChange[] = [];
  for (const [id, b] of before) {
    const a = after.get(id);
    if (!a) {
      removed.push({ id, title: nodeTitle(b), kind: 'removed', props: [], moreProps: 0 });
    } else if (b.parentId !== a.parentId) {
      moved.push({ id, title: nodeTitle(a), kind: 'moved', props: [], moreProps: 0 });
    } else {
      const props = diffProps(b, a);
      if (props.length > 0) {
        changed.push({ id, title: nodeTitle(a), kind: 'changed', props: props.slice(0, 3), moreProps: Math.max(0, props.length - 3) });
      }
    }
  }
  for (const [id, a] of after) {
    if (!before.has(id)) {
      added.push({ id, title: nodeTitle(a), kind: 'added', props: [], moreProps: 0 });
    }
  }
  const byTitle = (x: NodeChange, y: NodeChange) => x.title.localeCompare(y.title);
  removed.sort(byTitle);
  added.sort(byTitle);
  moved.sort(byTitle);
  changed.sort(byTitle);
  return { changes: [...removed, ...added, ...moved, ...changed], unparsed: false };
}
