// ConnectionTypeModal.tsx — Appears after dropping a connection handle on a target variant.
// Uses design system controls: ToolSelect, ToolPlusMinus, ToolInput, ToolRow.

import { useState, useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { addConnection, type ConnectionTrigger } from '@/code/variants/connection-config';
import { projectFS, projectVersionAtom } from '@/code/project/project-fs';
import { useSetAtom, useAtomValue } from 'jotai';
import { codeAtom, getNodesSnapshot } from '@/code/stores/store';
import { setCanvasNodeConnectionInCode } from '@/code/generation/generator-crud';
import { modifyProjectFile } from '@/code/project/modify-file';
import { activeFilePathAtom } from '@/code/project/active-file-store';
import { trace } from '@/shared/debug-trace';
import ToolSelect from '@/editor/controls/ToolSelect';
import ToolPlusMinus from '@/editor/controls/ToolPlusMinus';
import ToolInput from '@/editor/controls/ToolInput';
import ToolRow from '@/editor/controls/ToolRow';
import { RemoveButton } from '@/editor/controls/RemoveButton';

const TRIGGER_OPTIONS: { value: string; label: string }[] = [
  { value: 'click', label: 'Click' },
  { value: 'clickStart', label: 'Click Start' },
  { value: 'mouseEnter', label: 'Mouse Enter' },
  { value: 'mouseLeave', label: 'Mouse Leave' },
  { value: 'inView', label: 'In View' },
  { value: 'afterDelay', label: 'After Delay' },
];

interface Props {
  from: string;
  to: string;
  position: { x: number; y: number };
  /** When set, the generated event handler lands on the JSX element
   *  with this `data-id` (per-child trigger) instead of the variant
   *  root. */
  sourceNodeId?: string;
  onClose: () => void;
}

export default function ConnectionTypeModal({ from, to, position, sourceNodeId, onClose }: Props) {
  const activeFile = useAtomValue(activeFilePathAtom);
  const setCode = useSetAtom(codeAtom);
  const setVersion = useSetAtom(projectVersionAtom);
  const modalRef = useRef<HTMLDivElement>(null);
  const [trigger, setTrigger] = useState<ConnectionTrigger>('click');
  const [delay, setDelay] = useState(0);
  const [isVisible, setIsVisible] = useState(false);

  // Fade-in animation
  useEffect(() => {
    const t = setTimeout(() => setIsVisible(true), 10);
    return () => clearTimeout(t);
  }, []);

  // Close on click outside / Escape
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (modalRef.current && !modalRef.current.contains(e.target as Node)) onClose();
    };
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const t = setTimeout(() => window.addEventListener('mousedown', handleClick), 50);
    window.addEventListener('keydown', handleEsc);
    return () => {
      clearTimeout(t);
      window.removeEventListener('mousedown', handleClick);
      window.removeEventListener('keydown', handleEsc);
    };
  }, [onClose]);

  const handleCreate = useCallback(() => {
    trace.action('connection-modal:create', { from, to, trigger, delay, sourceNodeId });
    // A CANVAS NODE source can't run a live setVariant (module scope) → store the connection as a
    // `data-conn-target` attr on the node (the arrow renderer draws it; drag-back restores the live handler).
    const isCanvasSource = !!sourceNodeId && !!getNodesSnapshot().get(sourceNodeId)?.isCanvasNode;
    if (isCanvasSource) {
      modifyProjectFile(activeFile, (c) => setCanvasNodeConnectionInCode(c, sourceNodeId!, to, trigger));
    } else {
      addConnection(activeFile, from, to, trigger, delay, sourceNodeId);
    }
    setVersion(v => v + 1);
    const newCode = projectFS.readFile(activeFile);
    if (newCode) setCode(newCode);
    onClose();
  }, [from, to, trigger, delay, sourceNodeId, activeFile, setCode, setVersion, onClose]);

  // Keep modal within viewport
  const left = Math.min(position.x, window.innerWidth - 244);
  const top = Math.min(position.y, window.innerHeight - 280);

  return createPortal(
    <div
      ref={modalRef}
      className="flex flex-col"
      onMouseDown={(e) => e.stopPropagation()}
      onMouseUp={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      style={{
        position: 'fixed',
        left, top,
        width: 224,
        backgroundColor: 'var(--bg-surface)',
        border: '1px solid var(--border-default, #333)',
        borderRadius: 8,
        boxShadow: '0 8px 30px rgba(0,0,0,0.4)',
        zIndex: 10000,
        opacity: isVisible ? 1 : 0,
        transition: 'opacity 0.15s ease-out',
      }}
    >
      {/* Header — match ToolPopup */}
      <div className="flex items-center justify-between px-3 pt-3 pb-1.5">
        <span className="text-xs font-bold text-[var(--text-primary)]">Connection Type</span>
        <RemoveButton onClick={onClose} />
      </div>

      {/* Content */}
      <div className="px-3 pb-3 pt-1 flex flex-col gap-3">
        {/* Type select */}
        <ToolRow label="Type">
          <ToolSelect
            value={trigger}
            onChange={(v) => setTrigger(v as ConnectionTrigger)}
            options={TRIGGER_OPTIONS}
          />
        </ToolRow>

        {/* Delay — plus/minus stepper, no arbitrary 2s ceiling (max 1000s) */}
        <ToolRow label="Delay">
          <ToolPlusMinus
            value={delay}
            min={0}
            max={1000}
            step={0.1}
            onChange={(v: number) => setDelay(Math.round(v * 10) / 10)}
          />
          <ToolInput
            value={String(delay)}
            onChange={(v) => setDelay(Math.max(0, Math.min(1000, parseFloat(v) || 0)))}
            step={0.1}
            chevronLabel="s"
            className="!w-16 shrink-0"
          />
        </ToolRow>

        {/* Create button */}
        <div className="pt-2">
          <button
            onClick={handleCreate}
            className="w-full h-8 text-xs font-medium text-[var(--accent-secondary-fg)] rounded-[var(--radius-lg)] transition-colors hover:opacity-90"
            style={{ backgroundColor: 'var(--accent-secondary)' }}
          >
            Create Connection
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
