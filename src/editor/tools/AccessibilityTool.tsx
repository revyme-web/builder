// AccessibilityTool.tsx — Semantic tag + aria-label editor.
// Toggle with +/- button. Only shows tag select for frame/text nodes (not SVG/img).
// Tag change uses changeTag mutation; aria-label uses updateHtmlAttrs mutation.

import { useState, useCallback, useEffect } from 'react';
import { ToolSection, ToolInput, ToolSelect, ControlLabel } from '../controls';
import { useControl } from '../controls/ControlProvider';
import { queueMutation } from '@/code/mutation/mutation-queue';
import { trace } from '@/shared/debug-trace';
import { isFrameTag, isTextTag } from '@/shared/constants';

const FRAME_TAG_OPTIONS = [
  { value: 'div', label: 'div' },
  { value: 'section', label: 'section' },
  { value: 'article', label: 'article' },
  { value: 'aside', label: 'aside' },
  { value: 'nav', label: 'nav' },
  { value: 'header', label: 'header' },
  { value: 'footer', label: 'footer' },
  { value: 'main', label: 'main' },
  { value: 'figure', label: 'figure' },
  { value: 'figcaption', label: 'figcaption' },
];

const TEXT_TAG_OPTIONS = [
  { value: 'p', label: 'p' },
  { value: 'span', label: 'span' },
  { value: 'h1', label: 'h1' },
  { value: 'h2', label: 'h2' },
  { value: 'h3', label: 'h3' },
  { value: 'h4', label: 'h4' },
  { value: 'h5', label: 'h5' },
  { value: 'h6', label: 'h6' },
  { value: 'a', label: 'a' },
  { value: 'label', label: 'label' },
  { value: 'strong', label: 'strong' },
  { value: 'em', label: 'em' },
];

export default function AccessibilityTool() {
  const { node, nodeId } = useControl();

  const elementTag = node?.type || '';
  const ariaLabel = node?.attrs?.['aria-label'] ?? '';

  const isFrame = isFrameTag(elementTag);
  const isText = isTextTag(elementTag);
  const canEditTag = isFrame || isText;
  const tagOptions = isFrame ? FRAME_TAG_OPTIONS : TEXT_TAG_OPTIONS;

  const [open, setOpen] = useState(false);
  const [localAriaLabel, setLocalAriaLabel] = useState(ariaLabel);

  // When selection changes: sync aria-label and auto-open if it already has one
  useEffect(() => {
    setLocalAriaLabel(ariaLabel);
    setOpen(!!ariaLabel);
  }, [nodeId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep local in sync when code changes update the node
  useEffect(() => {
    setLocalAriaLabel(ariaLabel);
  }, [ariaLabel]);

  const commitAriaLabel = useCallback((value: string) => {
    if (!nodeId) return;
    const trimmed = value.trim();
    trace.action('accessibility-tool:update-aria-label', { nodeId, to: trimmed });
    queueMutation({ type: 'updateHtmlAttrs', nodeId, attrs: { 'aria-label': trimmed } });
  }, [nodeId]);

  const commitTag = useCallback((value: string) => {
    if (!nodeId || value === elementTag) return;
    trace.action('accessibility-tool:change-tag', { nodeId, from: elementTag, to: value });
    queueMutation({ type: 'changeTag', nodeId, newTag: value });
  }, [nodeId, elementTag]);

  const handleToggle = useCallback(() => {
    const next = !open;
    trace.action('accessibility-tool:toggle', { nodeId, open: next });
    if (!next && ariaLabel && nodeId) {
      // Remove aria-label when collapsing
      queueMutation({ type: 'updateHtmlAttrs', nodeId, attrs: { 'aria-label': '' } });
      setLocalAriaLabel('');
    }
    setOpen(next);
  }, [open, ariaLabel, nodeId]);

  trace.fn('AccessibilityTool:render', { nodeId, elementTag, ariaLabel, open, canEditTag });

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
    <ToolSection title="Accessibility" collapsible action={toggleBtn} hasContent={open}>
      {/* Always render a wrapper so ToolSection doesn't bail on empty children */}
      <div className="contents">
        {/* Semantic tag — only for frame/text nodes */}
        {canEditTag && (
          <div className="flex items-center justify-between w-full">
            <ControlLabel label="Element" property="__a11y-tag" plain />
            <div className="flex items-center gap-2 w-full">
              <ToolSelect
                value={elementTag}
                onChange={commitTag}
                options={tagOptions}
              />
            </div>
          </div>
        )}

        {/* Aria label */}
        <div className="flex items-center justify-between w-full">
          <ControlLabel label="Aria Label" property="aria-label" plain />
          <div className="flex items-center gap-2 w-full">
            <ToolInput
              value={localAriaLabel}
              onChange={(val) => {
                setLocalAriaLabel(val);
                commitAriaLabel(val);
              }}
              text
            />
          </div>
        </div>
      </div>
    </ToolSection>
  );
}
