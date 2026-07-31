// TypographyPresetControl.tsx — Typography preset picker.
// Shows active preset label or "None". Click → opens preset list panel.
// Selecting a preset applies all var(--typo-*) references to the element.
// Edit button → slides to TypographyEditContent for in-place editing.
// Create → slides to name input → creates new preset group.

import { useState, useRef, useCallback, useMemo } from 'react';
import { useDebouncedCallback } from '@/editor/hooks/useDebouncedCallback';
import { useAtomValue, useSetAtom } from 'jotai';
import { ControlLabel, ControlActionRow, RemoveButton, TypoTagBadge, ToolDivider } from '../../../controls';
import { useControl } from '../../../controls/ControlProvider';
import ToolPopup, { useToolPopupOptional } from '../../../ui/ToolPopup';
import { TypographyEditContent } from '../../../left-toolbar/panels/LibraryPanel';
import { presetTokensAtom } from '@/code/stores/preset-store';
import { getPresetTokens } from '@/code/project/preset-ops';
import { refreshCanvasTokens, forceCanvasRender } from '@/canvas/node-ops';
import { getCanvasBridge } from '@/canvas/canvas-bridge';
import { queueMutation, setForceRender, flushNow } from '@/code/mutation/mutation-queue';
import { projectVersionAtom } from '@/code/project/project-fs';
import { trace } from '@/shared/debug-trace';
import {
  RESPONSIVE_PROPS,
  TYPO_VAR_PROP_MAP as VAR_PROP_MAP,
  bakePresetStyles,
  groupTypoTokens,
  getTypoTokenValue,
  getTypoTag,
  detectActivePreset,
  createDefaultTypoTokens,
} from '../../typography-utils';
import type { TypoGroup } from '../../typography-utils';

/** First family name from a preset's font token, falling back to Inter. */
function presetFontFamily(g: TypoGroup): string {
  const first = getTypoTokenValue(g, 'font').replace(/['",]/g, '').split(',')[0]?.trim();
  return first || 'Inter';
}

/** Short "16px / 1.6" detail line (size / line-height). */
function presetDetail(g: TypoGroup): string {
  const size = getTypoTokenValue(g, 'size');
  const lh = getTypoTokenValue(g, 'line-height');
  return [size, lh].filter(Boolean).join(' / ');
}

// ─── Preset List Panel ────────────────────────────────────────────────────────

function TypoPresetListPanel({ groups, activeGroupName, onApply, onEdit, onCreate }: {
  groups: TypoGroup[];
  activeGroupName: string | null;
  onApply: (group: TypoGroup) => void;
  onEdit: (group: TypoGroup) => void;
  onCreate: () => void;
}) {
  // Track selection locally so clicking a preset highlights it INSTANTLY and the popup stays open
  // (the reference's Text Styles behavior). Seeded from the currently-applied preset so opening the popup
  // auto-selects it. The pushed panel stays mounted, so this state persists across clicks.
  const [selected, setSelected] = useState<string | null>(activeGroupName);
  return (
    <div className="flex flex-col gap-0.5">
      {/* Create new — top button (compact, matches color picker) */}
      <button
        onClick={onCreate}
        className="w-full py-2 mb-0.5 text-xs text-[var(--text-primary)] bg-[var(--bg-hover)] hover:bg-[var(--control-border)] rounded-[var(--radius-md)] transition-colors flex items-center justify-center gap-1"
      >
        <span className="text-xs leading-none">+</span> Create New Preset
      </button>

      {/* Separator between the create action and the preset list — same divider as the properties panel. */}
      <ToolDivider />

      {/* Preset list — the reference "Text Styles" look: P badge + name (in the preset's own font) + size/LH
          detail. Selection is a subtle grey row, NOT the accent (the accent is loud/ugly for a list). */}
      {groups.map(g => {
        const isActive = g.name === selected;
        const detail = presetDetail(g);
        return (
          <div
            key={g.name}
            className={`group flex items-center gap-2 px-2 py-1.5 rounded-[var(--radius-md)] cursor-pointer transition-colors select-none ${
              isActive ? 'bg-[var(--bg-hover)]' : 'hover:bg-[var(--bg-hover)]'
            }`}
            style={{ minHeight: '32px', boxSizing: 'border-box' }}
            onClick={() => { setSelected(g.name); onApply(g); }}
          >
            <TypoTagBadge tag={getTypoTag(g)} active={isActive} />
            <span
              className="text-[11px] font-medium text-[var(--text-secondary)] truncate block flex-1"
              style={{ fontFamily: `'${presetFontFamily(g)}', Inter, sans-serif` }}
            >
              {g.label}
            </span>
            {/* Right slot: size/LH detail, swapped for an Edit button on hover. */}
            <span className="relative shrink-0 flex items-center justify-end min-w-[56px]">
              {detail && (
                <span className="text-[10px] text-[var(--text-secondary)] group-hover:opacity-0 transition-opacity">
                  {detail}
                </span>
              )}
              <button
                className="absolute right-0 text-[10px] px-2 py-1 rounded-[var(--radius-md)] bg-[var(--bg-active)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] opacity-0 group-hover:opacity-100 transition-opacity"
                onClick={(e) => { e.stopPropagation(); onEdit(g); }}
              >
                Edit
              </button>
            </span>
          </div>
        );
      })}

      {groups.length === 0 && (
        <div className="text-xs text-[var(--text-secondary)] text-center py-3">
          No typography presets yet
        </div>
      )}
    </div>
  );
}

// ─── Create Preset Panel ──────────────────────────────────────────────────────

/** Step 1: name input. Step 2: creates tokens → shows full TypographyEditContent. */
function CreateTypoPresetPanel({ onCreated }: { onCreated: (group: TypoGroup) => void }) {
  const [name, setName] = useState('');
  const [createdGroup, setCreatedGroup] = useState<TypoGroup | null>(null);
  const bumpVersion = useSetAtom(projectVersionAtom);

  const handleCreate = useCallback(() => {
    if (!name.trim()) return;
    const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');

    trace.action('typo-preset:create', { slug });
    createDefaultTypoTokens(slug).forEach(t => queueMutation({ type: 'addPresetToken', token: t }));

    bumpVersion(v => v + 1);

    // Read fresh tokens from ProjectFS (mutations already applied) for immediate group lookup
    const fresh = getPresetTokens();
    const groups = groupTypoTokens(fresh);
    const created = groups.find(g => g.name === slug);
    if (created) setCreatedGroup(created);
  }, [name, bumpVersion]);

  // Live-drag fast path: setProperty on the iframe contentRoot for the var.
  // Heavy bumpVersion + refreshCanvasTokens are debounced 300ms — running
  // them per drag tick triggers atom fan-out, panel re-render storms, and
  // CSS regex extraction, all of which kill framerate during a pointer drag.
  const { call: settle } = useDebouncedCallback(() => {
    bumpVersion(v => v + 1);
    refreshCanvasTokens();
  }, 300);
  const handleUpdate = useCallback((tokenName: string, value: string) => {
    const bridge = getCanvasBridge() as any;
    if (typeof bridge?.setCanvasTokenVar === 'function') {
      bridge.setCanvasTokenVar(tokenName, value);
    }
    queueMutation({ type: 'updatePresetToken', name: tokenName, value });
    settle();
  }, [settle]);

  // Step 2: full editor after creation
  if (createdGroup) {
    return (
      <div className="flex flex-col gap-3">
        <TypographyEditContent
          group={createdGroup}
          onUpdate={handleUpdate}
          onDelete={() => {}}
          onClose={() => onCreated(createdGroup)}
        />
        <button
          onClick={() => onCreated(createdGroup)}
          className="w-full h-7 rounded-[var(--radius-lg)] text-xs font-medium bg-[var(--accent)] text-white cursor-pointer hover:opacity-90 transition-colors"
        >
          Done
        </button>
      </div>
    );
  }

  // Step 1: name input
  return (
    <div className="flex flex-col gap-3">
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') handleCreate(); }}
        placeholder="Preset name"
        className="w-full bg-[var(--grid-line)] border border-[var(--control-border)] focus:border-[var(--border-focus)] rounded-[var(--radius-lg)] px-2.5 py-2 text-xs text-[var(--text-primary)] outline-none placeholder:text-[var(--text-disabled)]"
      />
      <button
        onClick={handleCreate}
        disabled={!name.trim()}
        className={`w-full h-7 rounded-[var(--radius-lg)] text-xs font-medium transition-colors ${
          name.trim()
            ? 'bg-[var(--accent)] text-white cursor-pointer hover:opacity-90'
            : 'bg-[var(--grid-line)] text-[var(--text-disabled)] cursor-not-allowed'
        }`}
      >
        Create
      </button>
    </div>
  );
}

// ─── Edit Preset Panel (reuses TypographyEditContent from LibraryPanel) ───────

function EditTypoPresetPanel({ group, nodeId, onClose }: { group: TypoGroup; nodeId?: string; onClose: () => void }) {
  const bumpVersion = useSetAtom(projectVersionAtom);

  // Re-generate @container rules whenever a responsive or min-width token changes
  const regenerateContainerRules = useCallback((updatedGroup: TypoGroup) => {
    if (!nodeId) return;
    const minDefault = parseInt(getTypoTokenValue(updatedGroup, 'min-default') || '1200', 10);
    const minMd = parseInt(getTypoTokenValue(updatedGroup, 'min-md') || '600', 10);

    // Clear old rules first
    queueMutation({ type: 'clearContainerStyles', nodeId });

    const tiers: { suffix: string; maxWidth: number }[] = [
      { suffix: 'md', maxWidth: minDefault - 1 },
      { suffix: 'sm', maxWidth: minMd - 1 },
    ];
    for (const { suffix: tier, maxWidth } of tiers) {
      if (maxWidth <= 0) continue;
      const containerStyles: Record<string, string> = {};
      for (const [propSuffix, cssProp] of Object.entries(RESPONSIVE_PROPS)) {
        const token = updatedGroup.tokens.find(t => t.name.endsWith(`-${propSuffix}-${tier}`));
        if (token) {
          containerStyles[cssProp] = `var(--typo-${updatedGroup.name}-${propSuffix}-${tier})`;
        }
      }
      if (Object.keys(containerStyles).length > 0) {
        queueMutation({ type: 'updateContainerStyle', nodeId, maxWidth, styles: containerStyles });
      }
    }
  }, [nodeId]);

  // Live-drag fast path — see handleUpdate's twin in the create-flow above.
  // Per drag tick: setProperty on iframe contentRoot, queue the durable
  // mutation, debounce the heavy bumpVersion + refreshCanvasTokens.
  const { call: editSettle } = useDebouncedCallback(() => {
    bumpVersion(v => v + 1);
    refreshCanvasTokens();
  }, 300);
  const handleUpdate = useCallback((tokenName: string, value: string) => {
    trace.action('typo-preset-edit:update', { tokenName, value });
    const bridge = getCanvasBridge() as any;
    if (typeof bridge?.setCanvasTokenVar === 'function') {
      bridge.setCanvasTokenVar(tokenName, value);
    }
    queueMutation({ type: 'updatePresetToken', name: tokenName, value });
    editSettle();

    // Tag change → retag the live element this preset is applied to (p → h2, …), so editing the
    // preset's Tag updates the canvas immediately, not just on the next apply.
    if (nodeId && tokenName.endsWith('-tag')) {
      trace.action('typo-preset-edit:retag', { nodeId, newTag: value });
      queueMutation({ type: 'changeTag', nodeId, newTag: value });
      setForceRender();
    }

    // If a responsive or min-width token changed, regenerate @container rules.
    // This runs every tick because container rules need to reflect breakpoint
    // changes immediately — but it only fires when the matching token names
    // hit (size-md / size-sm / min-default / min-md), so during a typical
    // single-token drag (e.g. font-size) it's a no-op.
    if (nodeId && (tokenName.match(/-(?:size|spacing|line-height)-(?:md|sm)$/) || tokenName.match(/-min-(?:default|md)$/))) {
      const fresh = getPresetTokens();
      const updatedGroup = groupTypoTokens(fresh).find(g => g.name === group.name);
      if (updatedGroup) regenerateContainerRules(updatedGroup);
    }
  }, [editSettle, nodeId, group.name, regenerateContainerRules]);

  const handleDelete = useCallback((name: string) => {
    // No-op — deletion from preset picker not needed
  }, []);

  return (
    <TypographyEditContent
      group={group}
      onUpdate={handleUpdate}
      onDelete={handleDelete}
      onClose={onClose}
    />
  );
}

// ─── Main Control ─────────────────────────────────────────────────────────────

/** Standalone panel content — wraps TypoPresetListPanel inside ToolPopup context */
function StandalonePresetPanel({ groups, activeGroupName, nodeId, onApply, onClose }: {
  groups: TypoGroup[];
  activeGroupName: string | null;
  nodeId?: string;
  onApply: (group: TypoGroup) => void;
  onClose: () => void;
}) {
  const popupCtx = useToolPopupOptional();

  // Apply but KEEP the popup open (the reference behavior) — the list highlights the clicked preset and the
  // user can keep trying others. The × / outside-click still closes it.
  const handleApply = (group: TypoGroup) => {
    onApply(group);
  };

  const handleEdit = (group: TypoGroup) => {
    popupCtx?.pushPanel(
      `Edit "${group.label}"`,
      <EditTypoPresetPanel group={group} nodeId={nodeId} onClose={() => popupCtx.popPanel()} />
    );
  };

  const handleCreate = () => {
    popupCtx?.pushPanel('New Typography Preset', (
      <CreateTypoPresetPanel onCreated={(created) => {
        onApply(created);
        onClose();
      }} />
    ));
  };

  return (
    <TypoPresetListPanel
      groups={groups}
      activeGroupName={activeGroupName}
      onApply={handleApply}
      onEdit={handleEdit}
      onCreate={handleCreate}
    />
  );
}

export function TypographyPresetControl() {
  const { styles, updateMultipleStyles, node } = useControl();
  const selectedIds = node ? [node.id] : [];
  const popupCtx = useToolPopupOptional();
  const allTokens = useAtomValue(presetTokensAtom);
  const rowRef = useRef<HTMLDivElement>(null);
  const [isOpen, setIsOpen] = useState(false);

  const typoGroups = useMemo(() => groupTypoTokens(allTokens), [allTokens]);
  const activeGroup = useMemo(() => detectActivePreset(styles, typoGroups), [styles, typoGroups]);

  /** Apply a typography preset: var() for bound props, resolved value for overridable ones,
   *  and @container rules for responsive tiers (md/sm). */
  const applyPreset = useCallback((group: TypoGroup) => {
    trace.action('typo-preset:apply', { group: group.name });
    const styleUpdates: Record<string, string> = {};
    // Bound properties → var() references
    for (const [suffix, cssProp] of Object.entries(VAR_PROP_MAP)) {
      const token = group.tokens.find(t => t.name.endsWith('-' + suffix));
      if (token) {
        styleUpdates[cssProp] = `var(--typo-${group.name}-${suffix})`;
      }
    }
    updateMultipleStyles(styleUpdates);

    // Clear stale @container rules for this node (from previous preset applications)
    // then generate fresh rules using the preset's own min-width breakpoints.
    const nodeId = selectedIds[0];
    if (!nodeId) {
      // The var() styles above already applied (via the text-edit/context write
      // path), but WITHOUT a node id the retag + responsive tier rules below are
      // SKIPPED — the preset looks applied yet never adapts on resize (live find
      // 2026-07-02: a heading preset applied inside a component master carried
      // no @media tiers). Trace loudly so the drop is diagnosable from the trace.
      trace.error('typo-preset:apply-no-node', { group: group.name, note: 'responsive tiers + retag skipped — no selected node id' });
      return;
    }

    // Retag the element to the preset's tag (p → h2, etc.) — the reference's Paragraph/Heading semantics.
    // Guarded: only when the node is currently a text tag and the tag actually differs, so applying a
    // preset never rewrites a non-text element or churns the AST for a no-op.
    const presetTag = getTypoTag(group);
    const currentTag = (node?.type || '').toLowerCase();
    const RETAGGABLE = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'span', 'div', 'a', 'label', 'li']);
    if (presetTag !== currentTag && RETAGGABLE.has(currentTag)) {
      trace.action('typo-preset:retag', { nodeId, from: currentTag, to: presetTag });
      queueMutation({ type: 'changeTag', nodeId, newTag: presetTag });
    }

    queueMutation({ type: 'clearContainerStyles', nodeId });

    const minDefault = parseInt(getTypoTokenValue(group, 'min-default') || '1200', 10);
    const minMd = parseInt(getTypoTokenValue(group, 'min-md') || '600', 10);

    const tiers: { suffix: string; maxWidth: number }[] = [
      { suffix: 'md', maxWidth: minDefault - 1 },  // e.g. max-width: 1199px
      { suffix: 'sm', maxWidth: minMd - 1 },        // e.g. max-width: 599px
    ];

    for (const { suffix: tier, maxWidth } of tiers) {
      if (maxWidth <= 0) continue;
      const containerStyles: Record<string, string> = {};
      for (const [propSuffix, cssProp] of Object.entries(RESPONSIVE_PROPS)) {
        const token = group.tokens.find(t => t.name.endsWith(`-${propSuffix}-${tier}`));
        if (token) {
          containerStyles[cssProp] = `var(--typo-${group.name}-${propSuffix}-${tier})`;
        }
      }
      if (Object.keys(containerStyles).length > 0) {
        trace.action('typo-preset:apply-responsive', { nodeId, tier, maxWidth, props: Object.keys(containerStyles) });
        queueMutation({ type: 'updateContainerStyle', nodeId, maxWidth, styles: containerStyles });
      }
    }

    // Paint the whole preset in ONE atomic frame. Applying a preset queues ~6 mutations (styles +
    // variant + changeTag + container×N) AND the instant style patch already happened — left to the
    // default RAF flush, each of the changeTag rebuild, the container-override atom, and the preset-token
    // atom drives its OWN render across several frames, so the user sees size/color "switch"
    // sequentially. setForceRender + flushNow + forceCanvasRender process every mutation synchronously
    // and repaint the final state (correct tag + resolved tokens) exactly once. Same trio as node-ops'
    // solo-replica-clear.
    setForceRender();
    flushNow();
    forceCanvasRender();
  }, [updateMultipleStyles, selectedIds, node]);

  /** Detach preset: BAKE its resolved values into inline styles so the text keeps
   *  its EXACT look (instead of reverting to the element default, which was too
   *  brutal). Only props BOUND to this preset — a `var(--typo-<group>-<suffix>)`
   *  reference — are resolved to their literal token value; literal overrides the
   *  user set (e.g. a custom font-size) are left untouched. Detaching follows
   *  automatically because `detectActivePreset` keys off the `-font` var, which is
   *  now a literal. @container responsive rules keep referencing the preset's vars
   *  (still resolved — the preset isn't deleted), so responsive sizing is unchanged. */
  const removePreset = useCallback(() => {
    if (!activeGroup) return;
    trace.action('typo-preset:remove-bake', { group: activeGroup.name });
    const styleUpdates = bakePresetStyles(activeGroup, styles);
    if (Object.keys(styleUpdates).length > 0) updateMultipleStyles(styleUpdates);
  }, [activeGroup, styles, updateMultipleStyles]);

  const handleClick = () => {
    if (popupCtx) {
      // Inside a ToolPopup — use pushPanel. Apply but keep the panel open (the list highlights the
      // clicked preset); the user pops out via the popup's back/close.
      const handleApply = (group: TypoGroup) => {
        applyPreset(group);
      };

      const handleEdit = (group: TypoGroup) => {
        popupCtx.pushPanel(
          `Edit "${group.label}"`,
          <EditTypoPresetPanel group={group} nodeId={selectedIds[0]} onClose={() => popupCtx.popPanel()} />
        );
      };

      const handleCreate = () => {
        popupCtx.pushPanel('New Typography Preset', (
          <CreateTypoPresetPanel onCreated={(created) => {
            applyPreset(created);
            popupCtx.popPanel();
            popupCtx.popPanel();
          }} />
        ));
      };

      popupCtx.pushPanel('Typography Preset', (
        <TypoPresetListPanel
          groups={typoGroups}
          activeGroupName={activeGroup?.name ?? null}
          onApply={handleApply}
          onEdit={handleEdit}
          onCreate={handleCreate}
        />
      ));
    } else {
      // Standalone — open ToolPopup
      setIsOpen(true);
    }
  };

  trace.fn('TypographyPresetControl:render', { active: activeGroup?.name ?? 'none' });

  return (
    <>
      <div ref={rowRef} className="flex items-center justify-between w-full">
        <ControlLabel label="Preset" property="" plain />
        {activeGroup ? (
          // Applied preset: a subtle row (NOT accent) with the P badge, the preset name in its own
          // font, and an × to detach — mirrors the reference's "P Body ×" text-style pill.
          <ControlActionRow onClick={handleClick}>
            <TypoTagBadge tag={getTypoTag(activeGroup)} card />
            <span
              className="text-xs text-[var(--text-primary)] truncate flex-1 text-left"
              style={{ fontFamily: `'${presetFontFamily(activeGroup)}', Inter, sans-serif` }}
            >
              {activeGroup.label}
            </span>
            <RemoveButton onClick={removePreset} />
          </ControlActionRow>
        ) : (
          <ControlActionRow onClick={handleClick}>
            <span className="text-[var(--text-secondary)]">None</span>
          </ControlActionRow>
        )}
      </div>
      {!popupCtx && (
        <ToolPopup isOpen={isOpen} onClose={() => setIsOpen(false)} title="Typography Preset" anchorRef={rowRef}>
          <StandalonePresetPanel
            groups={typoGroups}
            activeGroupName={activeGroup?.name ?? null}
            nodeId={selectedIds[0]}
            onApply={applyPreset}
            onClose={() => setIsOpen(false)}
          />
        </ToolPopup>
      )}
    </>
  );
}
