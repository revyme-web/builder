// SlotControl.tsx — Properties-panel control for a code-component `slot`.
//
// A `slot` control accepts connected CANVAS NODES as the component's
// children. Two presentations, matching the reference:
//   - SINGLE slot (slotMax === 1) — a plain select: None + each canvas node.
//   - MULTI slot — an "N Items" button opening a ToolPopup with one row per
//     connection (a select + a drag handle to reorder).
//
// Reorder uses @dnd-kit (Y-axis-locked, mirroring the CMS collection overlay's
// Items tab). Nodes are added ONLY by drawing a connection on the canvas —
// there is intentionally no "Add" button in this popup.
//
// Connecting/disconnecting/reordering fire slot mutations (slot-ops.ts).

import { useState, useMemo, useRef } from 'react';
import { useAtomValue } from 'jotai';
import { nodesAtom, codeAtom } from '@/code/stores/store';
import { queueMutation } from '@/code/mutation/mutation-queue';
import { getSlotConnections } from '@/code/generation/slot-ops';
import { ToolRow, ToolSelect } from '../controls';
import ToolPopup from '../ui/ToolPopup';
import type { SlotMax } from '@/code/components/controls-parser';
import { trace } from '@/shared/debug-trace';
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { restrictToVerticalAxis } from '@dnd-kit/modifiers';
import { CSS } from '@dnd-kit/utilities';

interface SlotControlProps {
  /** data-id of the slot-bearing code component instance. */
  componentId: string;
  /** Control label (e.g. "Content"). */
  label: string;
  /** Max canvas nodes connectable — a number or "infinite". */
  slotMax?: SlotMax;
}

interface SlotRowOption { value: string; label: string }

/** One reorderable row: a node select + a drag handle. The @dnd-kit listeners go
 *  on the HANDLE only (not the whole row) so the select stays interactive — the
 *  whole-row-draggable CMS pattern works there because those rows have no inner
 *  controls. `transform`/`transition` move the row in place (Y-axis only via the
 *  DndContext modifier), matching the CMS Items tab. */
function SortableSlotRow({ id, value, options, onChange }: {
  id: string;
  value: string;
  options: SlotRowOption[];
  onChange: (v: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  return (
    <div
      ref={setNodeRef}
      data-slot-row
      className="flex items-center gap-1.5 mb-1.5"
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
        position: 'relative',
        zIndex: isDragging ? 1 : 0,
      }}
    >
      <div className="flex-1">
        <ToolSelect value={value} onChange={onChange} options={options} />
      </div>
      <div
        {...attributes}
        {...listeners}
        title="Drag to reorder"
        className="shrink-0 w-5 h-8 flex items-center justify-center cursor-grab text-[var(--text-tertiary)] hover:text-[var(--text-primary)] select-none leading-none touch-none"
      >
        ⠿
      </div>
    </div>
  );
}

export default function SlotControl({ componentId, label, slotMax }: SlotControlProps) {
  const nodes = useAtomValue(nodesAtom);
  const code = useAtomValue(codeAtom);
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  trace.fn('SlotControl:render', { componentId, label, slotMax });

  // Connected = canvas nodes referenced into this component's slot.
  const connected = useMemo(
    () => getSlotConnections(code, componentId),
    [code, componentId],
  );
  // Every top-level canvas node — connectable into the slot.
  const allCanvas = useMemo(
    () => [...nodes.values()].filter(n => n.isCanvasNode && !n.parentId).map(n => n.id),
    [nodes],
  );

  const nodeName = (id: string) => nodes.get(id)?.name || id;
  const connect = (id: string) => {
    trace.action('slot-control:connect', { componentId, canvasNodeId: id });
    queueMutation({ type: 'connectSlot', componentId, canvasNodeId: id });
  };
  const disconnect = (id: string) => {
    trace.action('slot-control:disconnect', { componentId, canvasNodeId: id });
    queueMutation({ type: 'disconnectSlot', componentId, canvasNodeId: id });
  };
  const reorder = (from: number, to: number) => {
    if (from === to) return;
    trace.action('slot-control:reorder', { componentId, from, to });
    queueMutation({ type: 'reorderSlot', componentId, fromIndex: from, toIndex: to });
  };

  // ─── Single slot — a plain select ─────────────────────────────────────
  if (slotMax === 1) {
    const current = connected[0] ?? '';
    const options = [
      { value: '', label: 'None' },
      ...allCanvas.map(id => ({ value: id, label: nodeName(id) })),
    ];
    const onChange = (v: string) => {
      if (current && current !== v) disconnect(current);
      if (v && v !== current) connect(v);
    };
    return (
      <ToolRow label={label}>
        <ToolSelect value={current} onChange={onChange} options={options} />
      </ToolRow>
    );
  }

  // ─── Multi slot — "N Items" button + ToolPopup ────────────────────────
  /** Change a row's connection (Remove if newId is empty). */
  const changeRow = (oldId: string, newId: string) => {
    if (newId === oldId) return;
    disconnect(oldId);
    if (newId) connect(newId);
  };

  const rowOptions: SlotRowOption[] = [
    { value: '', label: '— Remove —' },
    ...allCanvas.map(id => ({ value: id, label: nodeName(id) })),
  ];

  // @dnd-kit reorder — translate the dragged id's old/new positions into the
  // index-based reorderSlot mutation.
  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const oldIndex = connected.indexOf(String(active.id));
    const newIndex = connected.indexOf(String(over.id));
    if (oldIndex < 0 || newIndex < 0) return;
    reorder(oldIndex, newIndex);
  };

  return (
    <ToolRow label={label}>
      <button
        ref={btnRef}
        onClick={() => setOpen(o => !o)}
        className="w-full h-[var(--control-height-sm)] px-2 flex items-center gap-1.5 text-xs rounded-md bg-[var(--control-bg)] border border-[var(--control-border)] hover:border-[var(--control-border-hover)] text-[var(--text-primary)] transition-colors"
      >
        <span className="font-mono text-[var(--accent-text)] text-[13px] leading-none">[ ]</span>
        <span className="flex-1 text-left">
          {connected.length} Item{connected.length === 1 ? '' : 's'}
        </span>
      </button>

      <ToolPopup isOpen={open} onClose={() => setOpen(false)} title={label} anchorRef={btnRef}>
        {/* ToolPopup wraps children in `px-3 pb-3 pt-1` — no extra padding. */}
        <div>
          {connected.length === 0 && (
            <div className="text-[11px] text-[var(--text-tertiary)] py-1">
              No content connected yet. Draw a connection from this component to a
              canvas node to add it.
            </div>
          )}
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            modifiers={[restrictToVerticalAxis]}
            onDragEnd={onDragEnd}
          >
            <SortableContext items={connected} strategy={verticalListSortingStrategy}>
              {connected.map((id) => (
                <SortableSlotRow
                  key={id}
                  id={id}
                  value={id}
                  options={rowOptions}
                  onChange={(v) => changeRow(id, v)}
                />
              ))}
            </SortableContext>
          </DndContext>
        </div>
      </ToolPopup>
    </ToolRow>
  );
}
