// ScrollSectionTool.tsx — turn any PAGE element into a scroll anchor target.
// standard "Scroll Section": a Name (the `id` other links scroll to via
// `/page#name`) + an Offset Y that lands the scroll a bit above/below the
// element (maps to CSS `scroll-margin-top`, so fixed headers don't cover it).
//
// Split out of the Link/Navigation tool: an anchor is its own concept (where
// you scroll TO), separate from where an element links FROM. Hidden on
// component masters — anchors are page sections, not component-owned.

import { useState, useCallback, useEffect } from 'react';
import { ToolSection, ToolInput, ControlLabel } from '../controls';
import { useControl } from '../controls/ControlProvider';
import { queueMutation } from '@/code/mutation/mutation-queue';
import { trace } from '@/shared/debug-trace';

/** Slugify an anchor name (matches the Link tool's slugify). NOT cms-ops' slugify: this one hyphenates punctuation ('a.b' -> 'a-b', cms-ops deletes it) and has no 'untitled' fallback — ids/tokens generated here must stay stable. Do not merge (phase-9 9.1c). */
function slugify(str: string): string {
  return str.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

/** Parse a `scroll-margin-top` style value to a number (px). */
function parseOffset(v: string | undefined): number {
  if (!v) return 0;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

export default function ScrollSectionTool() {
  const { node, nodeId } = useControl();

  const anchorId = node?.attrs?.id ?? '';
  const offsetY = parseOffset(node?.styles?.scrollMarginTop as string | undefined);

  const [open, setOpen] = useState(false);
  const [localName, setLocalName] = useState(anchorId);

  // Selection change → sync + auto-open when this element already IS an anchor.
  useEffect(() => {
    setLocalName(anchorId);
    setOpen(!!anchorId);
  }, [nodeId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setLocalName(anchorId); }, [anchorId]);

  const commitName = useCallback((value: string) => {
    if (!nodeId) return;
    const slug = slugify(value);
    setLocalName(slug);
    trace.action('scroll-section:name', { nodeId, to: slug });
    queueMutation({ type: 'updateHtmlAttrs', nodeId, attrs: { id: slug } });
  }, [nodeId]);

  // Offset Y → `scroll-margin-top`. 0 clears the property.
  const commitOffset = useCallback((n: number) => {
    if (!nodeId) return;
    trace.action('scroll-section:offset-y', { nodeId, offsetY: n });
    queueMutation({ type: 'updateStyles', nodeId, styles: { scrollMarginTop: n === 0 ? '' : `${n}px` } });
  }, [nodeId]);

  const handleToggle = useCallback(() => {
    const next = !open;
    trace.action('scroll-section:toggle', { nodeId, open: next });
    if (!next && nodeId) {
      // Collapsing clears both the anchor id and the offset.
      queueMutation({ type: 'updateHtmlAttrs', nodeId, attrs: { id: '' } });
      queueMutation({ type: 'updateStyles', nodeId, styles: { scrollMarginTop: '' } });
      setLocalName('');
    }
    setOpen(next);
  }, [open, nodeId]);

  trace.fn('ScrollSectionTool:render', { nodeId, anchorId, offsetY, open });

  const toggleBtn = (
    <button
      onClick={(e) => { e.stopPropagation(); handleToggle(); }}
      className="flex items-center justify-end pl-[80px] -ml-[80px] cursor-pointer group text-[var(--text-primary)]"
    >
      {open ? (
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="transition-opacity group-hover:opacity-80">
          <path d="M2 6H10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      ) : (
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="transition-opacity group-hover:opacity-80">
          <path d="M6 2V10M2 6H10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      )}
    </button>
  );

  return (
    <ToolSection title="Anchor" collapsible action={toggleBtn} hasContent={open}>
      <div className="contents">
        {/* Name → the element's `id` (other links scroll to `#<name>`). */}
        <div className="flex items-center justify-between w-full">
          <ControlLabel label="Name" property="__scroll-name" plain />
          <div className="flex items-center gap-2 w-full">
            <ToolInput
              value={localName}
              onChange={commitName}
              placeholder="# name"
              text
            />
          </div>
        </div>

        {/* Offset Y → scroll-margin-top. Numeric input (chevron stepper) plus
            explicit − / + steppers to nudge by 1, standard. */}
        <div className="flex items-center justify-between w-full">
          <ControlLabel label="Offset Y" property="scrollMarginTop" plain />
          <div className="flex items-center gap-2 w-full">
            <ToolInput
              value={String(offsetY)}
              onChange={(v) => commitOffset(parseOffset(v))}
              chevronLabel="px"
            />
            <div className="flex h-[var(--control-height)] shrink-0 cut-corners cut-border bg-[var(--grid-line)] border border-[var(--control-border)] [--cut-border-color:var(--control-border)] overflow-hidden">
              <button
                onClick={() => commitOffset(offsetY - 1)}
                className="w-8 flex items-center justify-center text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer transition-colors"
                title="Decrease offset"
              >
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6H10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
              </button>
              <div className="w-px bg-[var(--control-border)]" />
              <button
                onClick={() => commitOffset(offsetY + 1)}
                className="w-8 flex items-center justify-center text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer transition-colors"
                title="Increase offset"
              >
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M6 2V10M2 6H10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
              </button>
            </div>
          </div>
        </div>
      </div>
    </ToolSection>
  );
}
