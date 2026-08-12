// CodeEditor.tsx — Monaco editor synced with codeAtom + VS Code-style file tree

import Editor, { type OnMount } from "@monaco-editor/react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import {
  codeAtom,
  nodesAtom,
  selectedNodeAtom,
  selectedIdsAtom,
  updatingFromCanvasAtom,
  triggerAsyncParse,
  getNodesSnapshot,
} from "../code/stores/store";
import {
  activeFilePathAtom,
  switchActiveFile,
} from "../code/project/active-file-store";
import { projectFS, projectVersionAtom } from "../code/project/project-fs";
import { modifyProjectFile } from "../code/project/modify-file";
import { queueMutation } from "../code/mutation/mutation-queue";
import { flushNow, syncQueueCode } from "../code/mutation/mutation-queue";
import { getNodeLineRange } from "../code/parsing/parser";
import { useRef, useEffect, useState, useCallback } from "react";
import { trace } from "../shared/debug-trace";
import { useIsDark } from "@/shared/useIsDark";
import NameInputModal from "@/editor/ui/NameInputModal";
import { userAtom } from "@/backend/user-store";
import type * as monaco from "monaco-editor";

// Only the admin account may edit the generated source directly — everyone
// else is view-only, because the canvas resolves this code in a very
// opinionated way and hand edits would corrupt that resolution. Admin status
// comes from the server (`user.isAdmin`, mirroring the `ADMIN_EMAILS` env
// allowlist) — never hardcode an address here.

// ─── File Tree ───────────────────────────────────────────────────────────────

interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children: TreeNode[];
}

function buildTree(files: string[]): TreeNode[] {
  const root: TreeNode[] = [];

  for (const filePath of files) {
    const parts = filePath.split("/");
    let current = root;
    let accumulated = "";

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      accumulated += (i > 0 ? "/" : "") + part;
      const isLast = i === parts.length - 1;

      let node = current.find((n) => n.name === part);
      if (!node) {
        node = { name: part, path: accumulated, isDir: !isLast, children: [] };
        current.push(node);
      }
      current = node.children;
    }
  }

  // Sort: directories first, then alphabetical
  const sortTree = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    nodes.forEach((n) => sortTree(n.children));
  };
  sortTree(root);
  return root;
}

function FileTreeNode({
  node,
  depth,
  activeFile,
  onSelect,
  onDelete,
}: {
  node: TreeNode;
  depth: number;
  activeFile: string;
  onSelect: (path: string) => void;
  onDelete?: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const isActive = node.path === activeFile;
  const indent = depth * 12;

  if (node.isDir) {
    return (
      <>
        <div
          className="flex items-center gap-1 cursor-pointer select-none hover:bg-[var(--bg-hover)] transition-colors"
          style={{ paddingLeft: indent + 4, paddingRight: 4, height: 24 }}
          onClick={() => setExpanded(!expanded)}
        >
          <svg
            width="10"
            height="10"
            viewBox="0 0 10 10"
            className="shrink-0 text-[var(--text-disabled)]"
            style={{
              transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
              transition: "transform 0.1s",
            }}
          >
            <path
              d="M3 1 L7 5 L3 9"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            />
          </svg>
          <span className="text-[11px] font-semibold text-[var(--text-secondary)] truncate">
            {node.name}
          </span>
        </div>
        {expanded &&
          node.children.map((child) => (
            <FileTreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              activeFile={activeFile}
              onSelect={onSelect}
              onDelete={onDelete}
            />
          ))}
      </>
    );
  }

  return (
    <div
      className={`group flex items-center gap-1.5 cursor-pointer select-none transition-colors ${
        isActive
          ? "bg-[var(--accent)]/15 text-[var(--accent-text)]"
          : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
      }`}
      style={{ paddingLeft: indent + 18, paddingRight: 4, height: 24 }}
      onClick={() => onSelect(node.path)}
    >
      <svg
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        className="shrink-0 opacity-50"
      >
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
      </svg>
      <span className="text-[11px] truncate flex-1">{node.name}</span>
      {onDelete && (
        <button
          className="opacity-0 group-hover:opacity-100 p-0.5 hover:text-red-400 transition-opacity shrink-0"
          onClick={(e) => {
            e.stopPropagation();
            onDelete(node.path);
          }}
          title="Delete file"
        >
          <svg
            width="11"
            height="11"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
          </svg>
        </button>
      )}
    </div>
  );
}

// ─── Main CodeEditor ─────────────────────────────────────────────────────────

export default function CodeEditor() {
  const isDark = useIsDark();
  const [code, setCode] = useAtom(codeAtom);
  const updatingFromCanvas = useAtomValue(updatingFromCanvasAtom);
  const selectedId = useAtomValue(selectedNodeAtom);
  const setNodes = useSetAtom(nodesAtom);
  const [activeFilePath, setActiveFile] = useAtom(activeFilePathAtom);
  const setSelectedIds = useSetAtom(selectedIdsAtom);
  const setUpdatingFromCanvas = useSetAtom(updatingFromCanvasAtom);
  const projectVersion = useAtomValue(projectVersionAtom);
  const bumpVersion = useSetAtom(projectVersionAtom);
  const skipNextChangeRef = useRef(false);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const decorationsRef =
    useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
  // "New File" path prompt — NameInputModal replaces window.prompt.
  const [newFileModalOpen, setNewFileModalOpen] = useState(false);

  // Admin-only WRITE toggle. Default view-only for everyone; an admin can flip
  // it on to hand-edit the generated source. Non-admins never see the toggle
  // and the editor stays read-only.
  const currentUser = useAtomValue(userAtom);
  const isAdmin = !!currentUser?.isAdmin;
  const [writeEnabled, setWriteEnabled] = useState(false);
  const canWrite = isAdmin && writeEnabled;
  // Apply read-only imperatively on toggle — the options prop covers mount, this
  // guarantees a live Write flip takes effect on the mounted editor instance.
  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly: !canWrite, domReadOnly: !canWrite });
  }, [canWrite]);

  // Build file tree from projectFS
  const allFiles = projectFS.listFiles();
  const tree = buildTree(allFiles);

  // ─── View path — DECOUPLED from the canvas's active file ────────────────
  // The explorer picks which file's code the editor SHOWS; it must never
  // navigate the builder (clicking a page here used to switch the canvas
  // page behind the popup). The view still FOLLOWS the active file one-way:
  // opening the editor lands on the page you're on, and external navigation
  // (Pages panel, entering a master) re-syncs it.
  const [viewPath, setViewPath] = useState(activeFilePath);
  useEffect(() => { setViewPath(activeFilePath); }, [activeFilePath]);
  const isViewingActive = viewPath === activeFilePath;
  // Non-active files read straight from projectFS — the projectVersion
  // subscription above re-renders this on any FS change, keeping it fresh.
  const viewCode = isViewingActive ? code : (projectFS.readFile(viewPath) ?? '');

  // CLOBBER GUARD (2026-07-23): switching files re-points `viewPath` BEFORE
  // Monaco's controlled value swaps — a change event slipping through in that
  // window carries the PREVIOUS file's full text and would be written to the
  // NEWLY selected path (through setCode when that's the active page: the
  // "Home page replaced by providers.tsx while clicking the explorer" data
  // loss). Snapshot what the buffer held at switch time; onChange drops any
  // event whose payload is verbatim that snapshot.
  const lastSwitchRef = useRef<{ fromPath: string; fromCode: string } | null>(null);

  const handleFileSelect = useCallback(
    (filePath: string) => {
      trace.action("code-editor:view-file", { from: viewPath, to: filePath });
      lastSwitchRef.current = { fromPath: viewPath, fromCode: viewCode };
      setViewPath(filePath);
    },
    [viewPath, viewCode]
  );

  const handleDeleteFile = useCallback(
    (filePath: string) => {
      // Don't delete the main page
      if (filePath === "app/page.tsx") return;

      // Check if component is used by any page
      if (filePath.startsWith("components/")) {
        const componentName = filePath
          .replace("components/", "")
          .replace(".tsx", "")
          .replace(".jsx", "");
        const tagRegex = new RegExp(`<${componentName}[\\s/>]`);
        const usedBy: string[] = [];
        for (const f of projectFS.listFiles()) {
          if (f === filePath) continue;
          const content = projectFS.readFile(f);
          if (content && tagRegex.test(content)) usedBy.push(f);
        }
        if (usedBy.length > 0) {
          const msg = `"${componentName}" is used in:\n${usedBy.join("\n")}\n\nDelete anyway? The component references will break.`;
          if (!window.confirm(msg)) return;
        }
      }

      if (!window.confirm(`Delete "${filePath}"?`)) return;

      trace.action("code-editor:delete-file", { filePath });

      // Deleting the CANVAS's active file must move the canvas off it —
      // the one legit navigation left in here. (The view-path sync effect
      // then follows automatically.) Deleting a merely-VIEWED file just
      // snaps the view back to the active file.
      if (filePath === activeFilePath) {
        switchActiveFile(
          activeFilePath,
          "app/page.tsx",
          { setActiveFile, setSelectedIds, setUpdatingFromCanvas },
          { syncQueueCode, flushNow }
        );
      } else if (filePath === viewPath) {
        setViewPath(activeFilePath);
      }

      queueMutation({ type: "deleteFile", filePath });
    },
    [activeFilePath, viewPath, setActiveFile, setSelectedIds, setUpdatingFromCanvas]
  );

  const handleMount: OnMount = (editor) => {
    editorRef.current = editor;
  };

  // Track previous selectedId to detect actual selection changes (vs code-only changes)
  const prevSelectedIdRef = useRef<string | null>(null);

  // Highlight selected node's full JSX block — updates on code OR selection change
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;

    // Clear previous highlight
    if (decorationsRef.current) {
      decorationsRef.current.clear();
      decorationsRef.current = null;
    }

    if (!selectedId) {
      prevSelectedIdRef.current = null;
      return;
    }

    // Node highlight only makes sense when the editor shows the CANVAS's
    // active file — the selection's ranges belong to that source.
    if (!isViewingActive) return;

    // Get node's tag name for component instance fallback (components lack data-id in source)
    const selectedNode = getNodesSnapshot().get(selectedId);
    const tagName = selectedNode?.name || undefined;

    const range = getNodeLineRange(code, selectedId, tagName);
    if (!range) return;

    const model = editor.getModel();
    if (!model) return;

    // Highlight the entirje block
    const endCol = model.getLineMaxColumn(range.endLine);
    decorationsRef.current = editor.createDecorationsCollection([
      {
        range: {
          startLineNumber: range.startLine,
          startColumn: 1,
          endLineNumber: range.endLine,
          endColumn: endCol,
        },
        options: {
          isWholeLine: true,
          className: "selected-node-highlight",
          overviewRuler: {
            color: "#6366f180",
            position: 1, // monaco.editor.OverviewRulerLane.Center
          },
        },
      },
    ]);

    // Only scroll when the SELECTION changed (user clicked a node).
    // Don't scroll on code changes (style edits) — it's jarring when editing via properties panel.
    if (selectedId !== prevSelectedIdRef.current) {
      editor.revealLineInCenter(range.startLine);
      prevSelectedIdRef.current = selectedId;
    }
  }, [selectedId, code]);

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "row",
      }}
    >
      {/* File tree sidebar */}
      <div
        style={{
          width: 160,
          minWidth: 120,
          flexShrink: 0,
          borderRight: "1px solid var(--border-light)",
          overflowY: "auto",
          overflowX: "hidden",
          paddingTop: 6,
          paddingBottom: 6,
        }}
        className="scrollbar-hide"
      >
        <div
          style={{
            padding: "4px 8px 6px",
            fontSize: 10,
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            color: "var(--text-disabled)",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          Explorer
          <button
            onClick={() => setNewFileModalOpen(true)}
            className="hover:text-[var(--text-primary)] transition-colors cursor-pointer"
            title="New File"
            style={{ background: 'none', border: 'none', color: 'inherit', padding: 0, fontSize: 14, lineHeight: 1 }}
          >+</button>
        </div>
        {tree.map((node) => (
          <FileTreeNode
            key={node.path}
            node={node}
            depth={0}
            activeFile={viewPath}
            onSelect={handleFileSelect}
            onDelete={handleDeleteFile}
          />
        ))}
      </div>

      {/* Editor */}
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          minWidth: 0,
        }}
      >
        <div
          style={{
            padding: "6px 12px",
            borderBottom: "1px solid var(--border-light)",
            fontSize: 11,
            fontWeight: 500,
            color: "var(--text-secondary)",
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            style={{ opacity: 0.5 }}
          >
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
          </svg>
          <span>{viewPath}</span>
          {isAdmin && (
            <button
              onClick={() => setWriteEnabled((v) => !v)}
              title={
                writeEnabled
                  ? "Editing enabled (admin) — changes write to the generated source. Click to lock."
                  : "Read-only. Click to enable editing (admin only)."
              }
              style={{
                marginLeft: "auto",
                display: "flex",
                alignItems: "center",
                gap: 5,
                padding: "2px 8px",
                borderRadius: 6,
                cursor: "pointer",
                border: "1px solid var(--border-light)",
                background: writeEnabled ? "var(--accent)" : "transparent",
                color: writeEnabled ? "#fff" : "var(--text-secondary)",
                fontSize: 10,
                fontWeight: 600,
                letterSpacing: 0.3,
                textTransform: "uppercase",
              }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 999,
                  background: writeEnabled ? "#fff" : "var(--text-disabled)",
                }}
              />
              Write
            </button>
          )}
        </div>
        <Editor
          height="100%"
          defaultLanguage="javascript"
          theme={isDark ? "vs-dark" : "vs"}
          value={viewCode}
          onMount={handleMount}
          onChange={(value) => {
            if (updatingFromCanvas) return;
            if (value === undefined) return;
            // Stale-buffer signature: right after a file switch, an event
            // whose text is EXACTLY the previous file's content is Monaco's
            // programmatic swap leaking through — never a user edit. Writing
            // it would clobber the new file with the old one's source.
            const ls = lastSwitchRef.current;
            if (ls && ls.fromPath !== viewPath && value === ls.fromCode) {
              trace.action('code-editor:dropped-stale-buffer-write', { fromPath: ls.fromPath, toPath: viewPath, size: value.length });
              return;
            }
            // STRUCTURAL GUARD: a real user edit requires keyboard focus in
            // the editor. Explorer clicks move focus OUT of Monaco, so any
            // change event arriving without text focus is the controlled
            // value swap (or another programmatic edit) leaking through —
            // writing it clobbers whichever file the view now points at.
            // (The signature guard above can be defeated by EOL
            // normalization; focus cannot.)
            if (!editorRef.current?.hasTextFocus()) {
              trace.action('code-editor:dropped-unfocused-write', { viewPath, size: value.length });
              return;
            }
            lastSwitchRef.current = null;
            if (isViewingActive) {
              setCode(value);
              // Parse in Web Worker (background thread) — canvas will update when result arrives
              triggerAsyncParse(value, setNodes);
            } else {
              // Viewing a NON-active file (view decoupled from canvas):
              // admin Write edits land on THAT file via the safe
              // read-modify-write path — never through codeAtom, which
              // belongs to the canvas's active file. skipParseGate: a human
              // deliberately saving WIP code is the one legitimate way a
              // broken file may be written; generator writes stay gated.
              modifyProjectFile(viewPath, () => value, { skipParseGate: true });
            }
          }}
          options={{
            minimap: { enabled: false },
            fontSize: 13,
            lineNumbers: "on",
            scrollBeyondLastLine: false,
            wordWrap: "on",
            tabSize: 2,
            padding: { top: 8 },
            automaticLayout: true,
            // READ-ONLY by default: the canvas resolves this source in a very
            // opinionated way (variant/slot/responsive codegen). Hand edits
            // would silently break that resolution, so the editor is view-only —
            // select, copy, scroll, but no typing/deleting. Only an admin who
            // has flipped the Write toggle (canWrite) may edit. `domReadOnly`
            // also blocks any DOM-level contentEditable edit; `readOnlyMessage`
            // explains why (shown only while read-only).
            readOnly: !canWrite,
            domReadOnly: !canWrite,
            readOnlyMessage: { value: 'Read-only — edit visually on the canvas; this code is generated.' },
          }}
        />
      </div>

      {/* "New File" path prompt — replaces the window.prompt that used
          to fire from the + button. The creation logic runs on submit. */}
      <NameInputModal
        isOpen={newFileModalOpen}
        onClose={() => setNewFileModalOpen(false)}
        onSubmit={(name) => {
          const filePath = name.startsWith('app/') || name.startsWith('lib/') || name.startsWith('components/') || name.startsWith('components/') || name.startsWith('cms/') || name.startsWith('i18n/')
            ? name : name;
          projectFS.writeFile(filePath, '');
          bumpVersion(v => v + 1);
          handleFileSelect(filePath);
          trace.action('code-editor:new-file', { filePath });
        }}
        title="New File"
        placeholder="New file path (e.g. lib/utils.ts)"
        submitLabel="Create File"
      />
    </div>
  );
}
