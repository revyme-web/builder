// LibraryPanel/index.tsx — Library panel with Components section at top
// and full Presets section below (all categories, inline create, edit popup).
// Merges the old PresetsPanel functionality directly into the Library panel.

import React, { useState, useRef, useCallback, useMemo, useEffect } from 'react';
import { useAtom, useAtomValue, useSetAtom, getDefaultStore } from 'jotai';
import { activeFilePathAtom, getFileDisplayName, switchActiveFile, componentBreadcrumbAtom, slugToFilePath, getRouteGroup } from '@/code/project/active-file-store';
import { hasComponentControls } from '@/code/components/controls-parser';
import ConfirmDialog from '@/design-system/ConfirmDialog';
import { generateInternalName, deleteComponent } from '@/code/components/component-ops';
import { generateIconSetName, buildIconSetFile, isIconSetCode } from '@/code/icons/icon-set-template';
import { enterComponentFile, getPrimaryVariantId } from '@/canvas/component-navigation';
import PluginsSection from '@/editor/left-toolbar/panels/plugins';
import { interactingViewportIdAtom } from '@/code/stores/viewport-store';
import { deleteIconSet } from '@/code/icons/icon-set-ops';
import { isIconSetFilePath } from '@/code/project/active-file-store';
import { componentEditorFileAtom } from '@/code/stores/component-editor-store';
import { suppressSelectionOverlayAtom } from '@/code/stores/editor-store';
import { projectFS, projectVersionAtom } from '@/code/project/project-fs';
import { selectedIdsAtom, updatingFromCanvasAtom, nodesAtom } from '@/code/stores/store';
import { presetTokensAtom, presetUsageAtom } from '@/code/stores/preset-store';
import { flushNow, syncQueueCode, queueMutation } from '@/code/mutation/mutation-queue';
import type { PresetToken } from '@/shared/types';
import ToolPopup from '@/editor/ui/ToolPopup';
import { refreshCanvasTokens } from '@/canvas/node-ops';
import { getCanvasBridge } from '@/canvas/canvas-bridge';
import { groupBorderTokens } from '@/editor/ui/border-preset-utils';
import EditBorderPresetPanel from '@/editor/ui/EditBorderPresetPanel';
import { trace } from '@/shared/debug-trace';
import SearchBar from '@/design-system/SearchBar';
import {
  groupTypoTokens as groupTypographyTokens,
  createDefaultTypoTokens,
} from '@/editor/tools/typography-utils';
import type { TypoGroup as TypographyGroup } from '@/editor/tools/typography-utils';

// Re-export TypographyGroup for consumers that import it from here
export type { TypographyGroup };

// Import + re-export TypographyEditContent so it stays available both as a
// public named export at the LibraryPanel module path (consumed by
// TypographyPresetControl in TextStyleTool) AND as a local binding usable
// inside the LibraryPanel preset edit popup below.
import { TypographyEditContent } from './presets/TypographyEditContent';
export { TypographyEditContent };

import {
  isDisplayOnly,
  type TokenCategory,
  type CategoryConfig,
} from './shared/types';
import {
  DATA_CATEGORIES,
  ALL_CATEGORIES,
} from './shared/constants';
import {
  formatTokenLabel,
  sanitizeName,
} from './shared/format-utils';
import { useLibraryMultiSelect } from './shared/useLibraryMultiSelect';
import {
  EditPopupContent,
} from './presets/EditPopupContent';
import {
  CategorySection,
  DisplayCategorySection,
} from './presets/CategorySection';
import { TemplatesSection } from './sections/TemplatesSection';
import { VectorsSection } from './sections/VectorsSection';
import { ComponentsSection } from './sections/ComponentsSection';

// ─── LibraryPanel ───────────────────────────────────────────────────────────

export default function LibraryPanel({ mode = 'all' }: { mode?: 'all' | 'library' | 'presets' }) {
  const [activeFile, setActiveFile] = useAtom(activeFilePathAtom);
  const setSelectedIds = useSetAtom(selectedIdsAtom);
  const setUpdatingFromCanvas = useSetAtom(updatingFromCanvasAtom);
  const setBreadcrumb = useSetAtom(componentBreadcrumbAtom);
  // Atoms used by `enterComponentFile` to navigate into a
  // master with auto-zoom-to-content. The setter is grabbed up here
  // (next to the other panel-level setters) so the switch callbacks
  // can reference it without a fresh useSetAtom each call.
  const setInteractingVp = useSetAtom(interactingViewportIdAtom);
  const jotaiStore = getDefaultStore();
  // Preset state
  const tokens = useAtomValue(presetTokensAtom);
  // Project-wide preset → consuming-nodes map. Re-derives whenever any file
  // changes (atom is keyed on `projectVersionAtom`), so the count badges +
  // jump-to-node popup stay coherent across edits / undo / redo.
  const presetUsageMap = useAtomValue(presetUsageAtom);
  const bumpVersion = useSetAtom(projectVersionAtom);
  // Subscribe to project version so the file lists below (computed via
  // projectFS.listFiles every render) re-derive when ANY file is added,
  // renamed, or removed — including newly-created icon sets, design
  // components, and code components that this panel itself wrote. The
  // value is unused (we only need the subscription); the projectVersion
  // bump after writeFile is what triggers the re-render.
  useAtomValue(projectVersionAtom);

  // Top-of-panel search input. Captures the query string; the per-
  // section filters consume it via `searchQuery` further down. Lowercased
  // once so each section's match check stays O(1) instead of re-lowering
  // on every row.
  const [searchQuery, setSearchQuery] = useState('');
  const searchActive = searchQuery.trim().length > 0;

  const [editingName, setEditingName] = useState<string | null>(null);
  const [renamingName, setRenamingName] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [creatingCategory, setCreatingCategory] = useState<string | null>(null);

  // Collapsed state for preset category accordions. In-memory only — resets
  // each session. Keys: TokenCategory for data categories, label string for
  // display-only ones.
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(() => new Set());
  const toggleCategoryCollapsed = useCallback((key: string) => {
    setCollapsedCategories(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      trace.action('library-panel:toggle-collapse', { key, collapsed: next.has(key) });
      return next;
    });
  }, []);

  const editAnchorRef = useRef<HTMLDivElement>(null);

  trace.fn('LibraryPanel.render', { tokenCount: tokens.length, editingName });

  // Ensure tokens.css exists on mount
  useEffect(() => {
    if (!projectFS.readFile('app/globals.css')) {
      const defaultCSS = `/* Design Tokens — Presets */\n:root {\n  /* Colors */\n  --color-brand: #6366f1;\n  --color-brand-light: #818cf8;\n  --color-surface: #ffffff;\n  --color-surface-dark: #0f0f1a;\n  --color-text: #111111;\n  --color-text-muted: #666666;\n  --color-text-light: #888888;\n  --color-accent: #6366f1;\n  --color-success: #22c55e;\n  --color-error: #ef4444;\n\n  /* Typography */\n  --typo-heading-font: 'Inter', sans-serif;\n  --typo-heading-size: 56px;\n  --typo-heading-weight: 700;\n  --typo-heading-spacing: -1.5px;\n  --typo-body-font: 'Inter', sans-serif;\n  --typo-body-size: 16px;\n  --typo-body-weight: 400;\n  --typo-body-line-height: 1.7;\n\n  /* Spacing */\n  --space-section-y: 80px;\n  --space-section-x: 60px;\n  --space-card-padding: 32px;\n  --space-gap: 24px;\n\n  /* Radius */\n  --radius-card: 16px;\n  --radius-button: 8px;\n  --radius-pill: 100px;\n\n  /* Shadows */\n  --shadow-card: 0 1px 3px rgba(0,0,0,0.06);\n  --shadow-elevated: 0 4px 12px rgba(0,0,0,0.1);\n}`;
      queueMutation({ type: 'writeFile', filePath: 'app/globals.css', content: defaultCSS });
      bumpVersion(v => v + 1);
      trace.action('library-panel:created-default-tokens-file');
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Get all component files, split into design vs code by @controls annotation
  const allComponentFiles = projectFS.listFiles('components/').filter(f => f.endsWith('.tsx'));
  const componentFiles: string[] = [];
  const codeComponentFiles: string[] = [];
  for (const f of allComponentFiles) {
    const code = projectFS.readFile(f);
    if (code && hasComponentControls(code)) {
      codeComponentFiles.push(f);
    } else {
      componentFiles.push(f);
    }
  }

  // Search filter — when the top-of-panel input has a query, narrow
  // every section's source list to entries whose display name or
  // file path contains the query (case-insensitive). The match helper
  // is a no-op when search is inactive so the existing behaviour
  // round-trips unchanged.
  const q = searchActive ? searchQuery.trim().toLowerCase() : '';
  const matchFile = (filePath: string): boolean => {
    if (!searchActive) return true;
    if (filePath.toLowerCase().includes(q)) return true;
    return getFileDisplayName(filePath).toLowerCase().includes(q);
  };
  const filteredComponentFiles = searchActive ? componentFiles.filter(matchFile) : componentFiles;
  const filteredCodeComponentFiles = searchActive ? codeComponentFiles.filter(matchFile) : codeComponentFiles;

  // Icon-set files live alongside components but in `icons/`. Filter by
  // the `@iconSet` annotation rather than just the path so a file someone
  // dropped in the folder by mistake (no annotation) doesn't show up
  // in the picker.
  const iconSetFiles = projectFS.listFiles('icons/')
    .filter(f => f.endsWith('.tsx'))
    .filter(f => {
      const code = projectFS.readFile(f);
      return !!code && isIconSetCode(code);
    });
  const filteredIconSetFiles = searchActive ? iconSetFiles.filter(matchFile) : iconSetFiles;
  const setComponentEditorFile = useSetAtom(componentEditorFileAtom);

  const switchToCodeComponent = useCallback((filePath: string) => {
    // Open the Code component Editor overlay (no file switching needed — overlay reads from ProjectFS directly)
    setComponentEditorFile(filePath);
    trace.action('library:open-code-component', { filePath });
  }, [setComponentEditorFile]);

  const switchToComponent = useCallback((filePath: string) => {
    // Route design-component navigation through `enterComponentFile`
    // (entryMode 'library', NO focus variant) — same path icon-set files
    // use. Two wins over the old plain `switchActiveFile`:
    //   1. no-flash pre-zoom (plain switchActiveFile left the camera at the
    //      stale page zoom until the user manually re-fit), and
    //   2. it RESTORES the component's SAVED camera (pan/zoom) when one exists
    //      (camera-persist) instead of always fitting — what the user expects
    //      when re-opening a component from the Library panel.
    // `collapseLibraryBreadcrumb` is applied inside enterComponentFile for
    // library mode, so all three library navigations share one breadcrumb rule.
    enterComponentFile(
      { fromFilePath: activeFile, componentFilePath: filePath, entryMode: 'library' },
      {
        setActiveFile,
        setBreadcrumb,
        setSelectedIds,
        setUpdatingFromCanvas,
        setInteractingViewport: setInteractingVp,
        getNodes: () => jotaiStore.get(nodesAtom),
        setSuppressSelectionOverlay: (v) => jotaiStore.set(suppressSelectionOverlayAtom, v),
      },
    );
  }, [activeFile, setActiveFile, setBreadcrumb, setSelectedIds, setUpdatingFromCanvas, setInteractingVp, jotaiStore]);

  // Icon-set master navigation — uses `enterComponentFile` so we get
  // the same pre-zoom/no-flash treatment as component
  // navigation. Without `enterComponentFile`, plain switchActiveFile
  // leaves the camera wherever the user was, then the iframe paints
  // the new master at that stale zoom (visible "wrong-zoom flash"
  // before the user manually re-fits). focusNodeId pins the camera +
  // selection on the primary variant on entry.
  const switchToIconSet = useCallback((filePath: string) => {
    enterComponentFile(
      {
        fromFilePath: activeFile,
        componentFilePath: filePath,
        focusNodeId: getPrimaryVariantId(filePath),
        // Library entry — keep `breadcrumb[0]` as the original page.
        entryMode: 'library',
      },
      {
        setActiveFile,
        setBreadcrumb,
        setSelectedIds,
        setUpdatingFromCanvas,
        setInteractingViewport: setInteractingVp,
        getNodes: () => jotaiStore.get(nodesAtom),
        setSuppressSelectionOverlay: (v) => jotaiStore.set(suppressSelectionOverlayAtom, v),
      },
    );
  }, [activeFile, setActiveFile, setBreadcrumb, setSelectedIds, setUpdatingFromCanvas, setInteractingVp, jotaiStore]);

  const createDesignComponent = useCallback((displayName: string) => {
    const internalName = generateInternalName();
    const filePath = `components/${internalName}.tsx`;
    const template = `'use client';\n\nimport React from 'react';\nimport { motion, LayoutGroup } from 'framer-motion';\nimport { withResponsiveProps } from '@revyme/runtime';\n\n/** @name "${displayName}" */\nconst variantConfig = [{ name: 'default', label: '${displayName}', x: 0, y: 0, isPrimary: true }];\n\nfunction ${internalName}({ style, initialVariant = 'default' }: { style?: React.CSSProperties; initialVariant?: string }) {\n  return (\n    <LayoutGroup>\n      <motion.div layout={true} data-id="${internalName.toLowerCase()}-root" data-name="${displayName}" style={{\n        position: 'relative',\n        width: '300px',\n        height: '300px',\n        backgroundColor: '#ffffff',\n        ...style,\n      }}>\n      </motion.div>\n    </LayoutGroup>\n  );\n}\n\nexport default withResponsiveProps(${internalName});\n`;
    projectFS.writeFile(filePath, template);
    bumpVersion(v => v + 1);
    trace.action('library:create-design-component', { filePath, displayName, internalName });
    switchToComponent(filePath);
  }, [switchToComponent, bumpVersion]);

  // Create an empty icon set with a single empty vector card. The
  // user draws shapes into it via the pencil/shape tools — starting
  // empty avoids "delete the placeholder rect first" friction.
  const createIconSet = useCallback((displayName: string) => {
    const internalName = generateIconSetName();
    const filePath = `icons/${internalName}.tsx`;
    const initialEntry = {
      id: 'icon-1',
      displayName: 'Vector',
      // No content — just an empty wrapper. buildIconJSXBlock keeps
      // the outer <div data-id="icon-1"> regardless of svgJSX, so the
      // master still has a selectable, drop-target card.
      svgJSX: '',
      leftPx: 0,
    };
    const code = buildIconSetFile(internalName, displayName, [initialEntry]);
    projectFS.writeFile(filePath, code);
    bumpVersion(v => v + 1);
    trace.action('library:create-icon-set', { filePath, displayName, internalName });
    switchToIconSet(filePath);
  }, [switchToIconSet, bumpVersion]);

  const createNewCodeComponent = useCallback((displayName: string) => {
    const internalName = generateInternalName();
    const filePath = `components/${internalName}.tsx`;
    const template = `'use client';\n\n/** @label "${displayName}" */\n/** @comment "A custom code component" */\n/** @controls {\n  "color": { "type": "color", "label": "Color", "default": "#3b82f6" },\n  "opacity": { "type": "slider", "label": "Opacity", "min": 0, "max": 1, "step": 0.01, "default": 1 }\n} */\n\nimport { withResponsiveProps } from '@revyme/runtime';\n\nfunction ${internalName}({\n  color = '#3b82f6',\n  opacity = 1,\n  ...props\n}: {\n  color?: string;\n  opacity?: number;\n  [key: string]: any;\n}) {\n  return (\n    <div {...props} style={{\n      ...((props as any).style || {}),\n      backgroundColor: color,\n      opacity,\n      width: '100%',\n      height: '100%',\n      borderRadius: '8px',\n    }} />\n  );\n}\n\nexport default withResponsiveProps(${internalName});\n`;
    projectFS.writeFile(filePath, template);
    bumpVersion(v => v + 1);
    trace.action('library:create-code-component', { filePath, displayName, internalName });
    switchToCodeComponent(filePath);
  }, [switchToCodeComponent, bumpVersion]);

  // Delete component — confirm dialog state
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const deleteConfirmName = deleteConfirm ? getFileDisplayName(deleteConfirm) : '';

  const handleDeleteComponent = useCallback((filePath: string) => {
    setComponentEditorFile(null);
    setDeleteConfirm(filePath);
  }, [setComponentEditorFile]);

  // Icon-set delete reuses the same confirm dialog (the dialog's behavior
  // — confirm + close + sync — is generic over file path). We dispatch
  // by inspecting the path in `confirmDeleteComponent` below.
  const handleDeleteIconSet = useCallback((filePath: string) => {
    setDeleteConfirm(filePath);
  }, []);

  // The actual delete (no UI / no confirm). Used both by the per-row
  // single-item confirm below AND by the section-level bulk-delete
  // flow (which has its OWN consolidated "Delete N components?"
  // confirm in `useLibraryMultiSelect`, so showing the per-component
  // confirm again per item would stack two modals back-to-back —
  // exactly the user-reported "Are you sure you want to delete
  // 'Frame'?" appearing after the bulk Delete N click).
  const performDeleteLibraryFile = useCallback((filePath: string) => {
    // If currently editing this file, switch away first. The home page may
    // live at `app/page.tsx` or inside a Template route group like
    // `app/(default)/page.tsx` — `slugToFilePath('home')` resolves to
    // whichever actually exists.
    if (activeFile === filePath) {
      flushNow();
      setActiveFile(slugToFilePath('home'));
      setSelectedIds([]);
      setBreadcrumb([]);
    }
    // Close component editor if open for this file
    setComponentEditorFile(null);
    // Dispatch to the right delete op based on file location. Icon-set
    // deletes go through deleteIconSet (which cleans instances + imports
    // across pages, same shape as deleteComponent).
    if (isIconSetFilePath(filePath)) {
      deleteIconSet(filePath);
      trace.action('library:delete-icon-set', { filePath });
    } else {
      deleteComponent(filePath);
      trace.action('library:delete-component', { filePath });
    }
    bumpVersion(v => v + 1);
  }, [activeFile, setActiveFile, setSelectedIds, setBreadcrumb, setComponentEditorFile, bumpVersion]);

  const confirmDeleteComponent = useCallback(() => {
    if (!deleteConfirm) return;
    performDeleteLibraryFile(deleteConfirm);
    setDeleteConfirm(null);
  }, [deleteConfirm, performDeleteLibraryFile]);

  // Group tokens by category. When search is active, narrow each
  // category bucket to tokens whose name OR value (stringified)
  // contains the query. Typography tokens land in their own bucket;
  // grouping into `typoGroups` further down derives from the filtered
  // entries here so a group whose every token misses the query
  // disappears entirely.
  const grouped = useMemo(() => {
    const map = new Map<TokenCategory, PresetToken[]>();
    for (const cat of DATA_CATEGORIES) {
      map.set(cat.key, []);
    }
    const ql = searchActive ? searchQuery.trim().toLowerCase() : '';
    for (const token of tokens) {
      if (searchActive) {
        const nameMatch = token.name.toLowerCase().includes(ql);
        const valueMatch = typeof token.value === 'string' && token.value.toLowerCase().includes(ql);
        if (!nameMatch && !valueMatch) continue;
      }
      const list = map.get(token.category);
      if (list) list.push(token);
    }
    return map;
  }, [tokens, searchActive, searchQuery]);

  // Group typography tokens into named groups (heading, body, etc.)
  const typoGroups = useMemo(() => {
    const typoTokens = grouped.get('typography') ?? [];
    return groupTypographyTokens(typoTokens);
  }, [grouped]);

  // Refresh tokens from ProjectFS — heavy. Bumps projectVersionAtom (fans
  // out to every subscriber → presetTokensAtom re-derives → parsePresetTokens
  // re-parses globals.css) and re-injects the full canvas-tokens block.
  // Safe to call when the user has settled, but NOT per drag tick.
  const refreshTokens = useCallback(() => {
    // FLUSH FIRST: every preset action queues its mutation then calls this —
    // bumping before the queue lands re-read the OLD tokens.css, so the
    // panel ran exactly one action behind (delete showed on the NEXT delete,
    // two creates appeared together — live find 2026-07-23).
    flushNow();
    bumpVersion(v => v + 1);
    // Re-inject tokens.css into canvas so CSS variables update immediately
    refreshCanvasTokens();
    trace.action('library-panel:refresh-tokens');
  }, [bumpVersion]);

  // Debounced refresh — preset-edit color pickers fire 60+ times/sec; running
  // refreshTokens per tick triggers a re-render storm (every ColorInput,
  // panel row, ServerPreview subscriber re-renders) plus repeated CSS
  // regex-extraction. Settle for 300ms after the drag ends instead.
  const refreshDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshTokensDebounced = useCallback(() => {
    if (refreshDebounceRef.current) clearTimeout(refreshDebounceRef.current);
    refreshDebounceRef.current = setTimeout(() => {
      refreshDebounceRef.current = null;
      refreshTokens();
    }, 300);
  }, [refreshTokens]);

  // Edit popup handlers
  const handleEdit = useCallback((name: string) => {
    trace.action('library-panel:edit-preset', { name });
    setEditingName(prev => prev === name ? null : name);
  }, []);

  const handleEditClose = useCallback(() => {
    trace.action('library-panel:edit-close');
    setEditingName(null);
  }, []);

  const handleUpdate = useCallback((name: string, value: string) => {
    trace.action('library-panel:update-preset', { name, value });
    // Live-drag fast path: set the CSS variable directly on the iframe's
    // contentRoot. setProperty is O(1); browser repaints var(--name)
    // consumers next frame. No version bump, no atom re-derive, no CSS
    // regex extraction, no panel re-render.
    const bridge = getCanvasBridge() as any;
    if (typeof bridge?.setCanvasTokenVar === 'function') {
      bridge.setCanvasTokenVar(name, value);
    }
    queueMutation({ type: 'updatePresetToken', name, value });
    refreshTokensDebounced();
  }, [refreshTokensDebounced]);

  const handleDelete = useCallback((name: string) => {
    trace.action('library-panel:delete-preset', { name });
    queueMutation({ type: 'removePresetToken', name });
    setEditingName(null);
    refreshTokens();
  }, [refreshTokens]);

  // ─── Shift-click multi-select + bulk delete (presets) ────────────────────
  // ONE instance spans every preset category, so a shift-pick can mix
  // colors + spacing + typography groups. Ids follow the editingName
  // scheme: plain token name, `typo-group:<name>`, `border-group:<name>` —
  // compound groups expand to all their constituent tokens on delete.
  const presetDisplayName = useCallback((id: string) => {
    if (id.startsWith('typo-group:')) {
      const groupName = id.slice('typo-group:'.length);
      return typoGroups.find(g => g.name === groupName)?.label ?? groupName;
    }
    if (id.startsWith('border-group:')) {
      const groupName = id.slice('border-group:'.length);
      const group = groupBorderTokens(grouped.get('border') ?? []).find(g => g.name === groupName);
      return group?.label ?? groupName;
    }
    const token = tokens.find(t => t.name === id);
    return token?.label ?? formatTokenLabel(id);
  }, [typoGroups, grouped, tokens]);

  const deletePresetById = useCallback((id: string) => {
    trace.action('library-panel:bulk-delete-preset', { id });
    if (id.startsWith('typo-group:')) {
      const groupName = id.slice('typo-group:'.length);
      const group = typoGroups.find(g => g.name === groupName);
      group?.tokens.forEach(t => queueMutation({ type: 'removePresetToken', name: t.name }));
    } else if (id.startsWith('border-group:')) {
      const groupName = id.slice('border-group:'.length);
      const group = groupBorderTokens(grouped.get('border') ?? []).find(g => g.name === groupName);
      group?.tokens.forEach(t => queueMutation({ type: 'removePresetToken', name: t.name }));
    } else {
      queueMutation({ type: 'removePresetToken', name: id });
    }
    setEditingName(null);
    refreshTokens();
  }, [typoGroups, grouped, refreshTokens]);

  const presetMultiSelect = useLibraryMultiSelect({
    itemLabel: 'presets',
    getDisplayName: presetDisplayName,
    onDelete: deletePresetById,
  });

  // Direct rename start — the row menus call this straight (the legacy
  // context-menu indirection is gone; deletes go via deletePresetById).
  const startRename = useCallback((name: string) => {
    trace.action('library-panel:rename-start', { name });
    setRenamingName(name);
    setRenameValue(name);
  }, []);

  const handleRenameSubmit = useCallback(() => {
    if (!renamingName || !renameValue.trim()) return;
    const sanitized = sanitizeName(renameValue);
    if (sanitized && sanitized !== renamingName) {
      trace.action('library-panel:rename-submit', { from: renamingName, to: sanitized });
      const token = tokens.find(t => t.name === renamingName);
      if (token) {
        queueMutation({ type: 'removePresetToken', name: renamingName });
        queueMutation({ type: 'addPresetToken', token: { name: sanitized, value: token.value, category: token.category } });
        refreshTokens();
      }
    }
    setRenamingName(null);
    setRenameValue('');
  }, [renamingName, renameValue, tokens, refreshTokens]);

  // Inline creation handlers
  const handleStartCreate = useCallback((categoryKey: string) => {
    trace.action('library-panel:create-start', { category: categoryKey });
    setCreatingCategory(categoryKey);
  }, []);

  const handleSubmitCreate = useCallback((config: CategoryConfig, displayName: string) => {
    const slug = sanitizeName(displayName);
    if (!slug) return;

    if (config.key === 'typography') {
      // Typography: create all tokens as a group
      trace.action('library-panel:create-typo-group', { category: config.key, slug });
      createDefaultTypoTokens(slug).forEach(t => queueMutation({ type: 'addPresetToken', token: t }));
      setCreatingCategory(null);
      refreshTokens();
      handleEdit(`typo-group:${slug}`);
    } else {
      const fullName = `${config.prefix}-${slug}`;
      trace.action('library-panel:create-preset', { category: config.key, name: fullName });
      queueMutation({ type: 'addPresetToken', token: {
        name: fullName,
        value: config.defaultValue,
        category: config.key,
      } });
      setCreatingCategory(null);
      refreshTokens();
      handleEdit(fullName);
    }
  }, [handleEdit, refreshTokens]);

  const handleCancelCreate = useCallback(() => {
    setCreatingCategory(null);
  }, []);

  // Find editing token for the popup (or typography / border group).
  const isEditingTypoGroup = editingName?.startsWith('typo-group:') ?? false;
  const editingTypoGroup = isEditingTypoGroup
    ? typoGroups.find(g => g.name === editingName!.replace('typo-group:', ''))
    : null;
  const isEditingBorderGroup = editingName?.startsWith('border-group:') ?? false;
  const editingBorderGroup = isEditingBorderGroup
    ? groupBorderTokens(tokens).find(g => g.name === editingName!.replace('border-group:', ''))
    : null;
  const editingToken = (!isEditingTypoGroup && !isEditingBorderGroup && editingName)
    ? tokens.find(t => t.name === editingName)
    : null;

  return (
    <div className="flex flex-col h-full bg-[var(--bg-surface)] select-none" data-library-panel>
      {/* Top-of-panel search — same chrome the Pages and Layers panels
          use (SearchBar + divider) so the four left panels read with a
          consistent header pattern. Placeholder adapts to the active
          mode: "Search library…" when the panel is showing
          Components/Vectors/Templates/Plugins, "Search presets…"
          when it's showing Typography/Color/etc.
          Spacing math: 12 px above (pt-3) the search bar matches 12 px
          below it down to the divider (pb-1.5 + mt-1.5 = 6 + 6). The
          first section below carries its own `pt-3` via SectionLabel,
          which is why this divider uses `mb-0` — without that, the
          previous ToolDivider's `my-2.5` (10 + 10 = 20 px) stacked on
          top of the section's `pt-3` (12 px) and ballooned the
          search-to-section gap to ~39 px, which the user flagged as
          too much whitespace below the bar.
          Filter wiring is local to each section below; this top input
          just owns the query string and passes it through. */}
      <div className="px-3 pt-3 pb-1.5 shrink-0">
        <SearchBar
          value={searchQuery}
          onChange={setSearchQuery}
          placeholder={mode === 'presets' ? 'Search presets…' : 'Search library…'}
        />
      </div>
      <div data-tool-divider className="h-px bg-[var(--border-light)] mx-3 mt-1.5 mb-0" />
      <div className="flex-1 overflow-y-auto [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]" ref={editAnchorRef}>
        {mode !== 'presets' && <>{/* Components Section — unified list with + dropdown */}
        <ComponentsSection
          componentFiles={filteredComponentFiles}
          codeComponentFiles={filteredCodeComponentFiles}
          activeFile={activeFile}
          onSwitchToComponent={switchToComponent}
          onSwitchToCodeComponent={switchToCodeComponent}
          onCreateDesignComponent={createDesignComponent}
          onCreateCodeComponent={createNewCodeComponent}
          onDeleteComponent={handleDeleteComponent}
          onBulkDeleteComponent={performDeleteLibraryFile}
        />

        {/* Vectors Section — top-level sibling of Components and Templates,
            owns icon-set files (`icons/{Pascal}.tsx` with `@iconSet`). */}
        <VectorsSection
          iconSetFiles={filteredIconSetFiles}
          activeFile={activeFile}
          onSwitchToIconSet={switchToIconSet}
          onCreateIconSet={createIconSet}
          onDeleteIconSet={handleDeleteIconSet}
          onBulkDeleteIconSet={performDeleteLibraryFile}
        />

        {/* Templates Section — standard page templates */}
        <TemplatesSection
          activeFile={activeFile}
          searchQuery={searchQuery}
          onEditTemplate={(clientPath) => {
            // Same flow as opening any other file: flush queue, clear
            // selection, switch active file. The right-panel Template
            // picker uses identical wiring.
            switchActiveFile(activeFile, clientPath,
              { setActiveFile, setSelectedIds, setUpdatingFromCanvas },
              { syncQueueCode, flushNow },
            );
          }}
          onTemplateDeleted={(name) => {
            // If we were editing this template's LayoutClient, its file was
            // just deleted — don't strand the user there. Exit to where they
            // came from (the breadcrumb origin) or Home, same target the
            // breadcrumb's own "back" uses.
            if (getRouteGroup(activeFile) !== name) return;
            const breadcrumb = jotaiStore.get(componentBreadcrumbAtom);
            const target = breadcrumb[0] ?? slugToFilePath('home');
            switchActiveFile(activeFile, target,
              { setActiveFile, setSelectedIds, setUpdatingFromCanvas },
              { syncQueueCode, flushNow },
            );
            setBreadcrumb([]);
          }}
        />

        {/* Plugins Section — installed/dev-URL plugins. Pass 1
            scope: list installed + add dev URL. */}
        <PluginsSection searchQuery={searchQuery} />
        </>}

        {mode !== 'library' && <>
        {/* All Preset Categories */}
        <div>
          {ALL_CATEGORIES.map((cat) => {
            if (isDisplayOnly(cat)) {
              return (
                <DisplayCategorySection
                  key={cat.label}
                  label={cat.label}
                  emptyLabel={cat.emptyLabel}
                  collapsed={collapsedCategories.has(cat.label)}
                  onToggleCollapse={() => toggleCategoryCollapsed(cat.label)}
                />
              );
            }
            const config = cat;
            const catTokens = grouped.get(config.key) ?? [];
            return (
              <CategorySection
                key={config.key}
                config={config}
                tokens={catTokens}
                typoGroups={config.key === 'typography' ? typoGroups : undefined}
                editingName={editingName}
                renamingName={renamingName}
                renameValue={renameValue}
                onRenameChange={setRenameValue}
                onRenameSubmit={handleRenameSubmit}
                onRenameCancel={() => { setRenamingName(null); setRenameValue(''); }}
                onEdit={handleEdit}
                onStartRename={startRename}
                onDeletePreset={deletePresetById}
                creating={creatingCategory === config.key}
                onStartCreate={() => handleStartCreate(config.key)}
                onCancelCreate={handleCancelCreate}
                onSubmitCreate={(name) => handleSubmitCreate(config, name)}
                collapsed={collapsedCategories.has(config.key)}
                onToggleCollapse={() => toggleCategoryCollapsed(config.key)}
                usageMap={presetUsageMap}
                multiSelect={presetMultiSelect}
              />
            );
          })}
        </div>
        </>}
        {/* Tail spacer — gives breathing room past the last category so it
            clears the bottom UI bar. A real DOM node always counts toward
            scrollHeight, regardless of parent layout. */}
        <div aria-hidden="true" style={{ height: '50px', flexShrink: 0 }} />
      </div>

      {/* Edit Popup — Typography Group */}
      {editingTypoGroup && (
        <ToolPopup
          isOpen={!!editingTypoGroup}
          onClose={handleEditClose}
          title={editingTypoGroup.label}
          anchorRef={editAnchorRef}
          width={280}
          resetKey={`typo-group:${editingTypoGroup.name}`}
          side="right"
        >
          <TypographyEditContent
            key={`typo-group:${editingTypoGroup.name}`}
            group={editingTypoGroup}
            onUpdate={handleUpdate}
            onDelete={handleDelete}
            onClose={handleEditClose}
          />
        </ToolPopup>
      )}

      {/* Edit Popup — Border Group (compound preset, all facets at once) */}
      {editingBorderGroup && (
        <ToolPopup
          isOpen={!!editingBorderGroup}
          onClose={handleEditClose}
          title={editingBorderGroup.label}
          anchorRef={editAnchorRef}
          width={280}
          resetKey={`border-group:${editingBorderGroup.name}`}
          side="right"
        >
          <EditBorderPresetPanel group={editingBorderGroup} />
        </ToolPopup>
      )}

      {/* Edit Popup — Regular Token */}
      {editingToken && (
        <ToolPopup
          isOpen={!!editingToken}
          onClose={handleEditClose}
          title={formatTokenLabel(editingToken.name)}
          anchorRef={editAnchorRef}
          width={280}
          resetKey={editingToken.name}
          side="right"
        >
          <EditPopupContent
            key={editingToken.name}
            token={editingToken}
            onUpdate={handleUpdate}
            onDelete={handleDelete}
            onClose={handleEditClose}
          />
        </ToolPopup>
      )}

      {/* Shared bulk-delete confirm for the preset multi-select — the
          hook owns the modal copy + Delete/Backspace shortcut. */}
      {presetMultiSelect.bulkDeleteModal}

      {/* Delete Component Confirm */}
      <ConfirmDialog
        isOpen={deleteConfirm !== null}
        onClose={() => setDeleteConfirm(null)}
        onConfirm={confirmDeleteComponent}
        title="Delete Component"
        message={`Are you sure you want to delete "${deleteConfirmName}"? All instances of this component will be removed from your project. This cannot be undone.`}
        confirmLabel="Delete"
        danger
      />

    </div>
  );
}
