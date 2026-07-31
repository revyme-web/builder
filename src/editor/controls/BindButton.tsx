// BindButton.tsx — Small bind/unbind button for CMS field binding.
// Shows a plug icon when unbound, a purple pill with field name when bound.
// Click opens a dropdown of fields from the parent collection.
// Only shown when selected node is inside a collection template (.map()).

import { useState, useRef, useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useAtomValue } from 'jotai';
import { collectionSchemasAtom } from '@/code/stores/cms-store';
import { getCollectionSchema } from '@/code/project/cms-ops';
import { queueMutation } from '@/code/mutation/mutation-queue';
import { trace } from '@/shared/debug-trace';

interface BindButtonProps {
  nodeId: string;
  /** The property being bound: 'text', 'src', 'href', 'alt' */
  property: 'text' | 'src' | 'href' | 'alt';
  /** Current binding field ID, or undefined if unbound */
  currentBinding?: string;
  /** Collection slug the template belongs to */
  collectionSlug: string;
  /** The .map() item variable name (e.g. 'item', 'post') */
  itemVar: string;
}

export function BindButton({ nodeId, property, currentBinding, collectionSlug, itemVar }: BindButtonProps) {
  const schemas = useAtomValue(collectionSchemasAtom);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [dropdownPos, setDropdownPos] = useState({ x: 0, y: 0 });
  const btnRef = useRef<HTMLButtonElement>(null);

  const schema = schemas.get(collectionSlug) ?? getCollectionSchema(collectionSlug);
  const fields = schema?.fields ?? [];
  const isBound = !!currentBinding;
  const boundField = fields.find(f => f.id === currentBinding);

  trace.fn('BindButton.render', { nodeId, property, currentBinding, collectionSlug, isBound });

  // Open dropdown
  const openDropdown = useCallback(() => {
    if (!btnRef.current) return;
    const rect = btnRef.current.getBoundingClientRect();
    const menuWidth = 160;
    const padding = 12;

    let x = rect.right + 4;
    if (x + menuWidth > window.innerWidth - padding) {
      x = rect.left - menuWidth - 4;
    }
    let y = rect.top;
    if (y + 200 > window.innerHeight - padding) {
      y = window.innerHeight - 200 - padding;
    }

    setDropdownPos({ x, y });
    setDropdownOpen(true);
    trace.action('bind-button:open-dropdown', { nodeId, property, collectionSlug });
  }, [nodeId, property, collectionSlug]);

  const closeDropdown = useCallback(() => setDropdownOpen(false), []);

  // Close on Escape
  useEffect(() => {
    if (!dropdownOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); closeDropdown(); }
    };
    window.addEventListener('keydown', handleKey, true);
    return () => window.removeEventListener('keydown', handleKey, true);
  }, [dropdownOpen, closeDropdown]);

  // Bind a field
  const handleBind = useCallback((fieldId: string) => {
    trace.action('bind-button:bind', { nodeId, property, fieldId, itemVar });
    queueMutation({ type: 'bindField', nodeId, property, fieldId, itemVar });
    closeDropdown();
  }, [nodeId, property, itemVar, closeDropdown]);

  // Unbind
  const handleUnbind = useCallback(() => {
    trace.action('bind-button:unbind', { nodeId, property });
    // Replace with empty placeholder text
    const staticValue = property === 'text' ? 'Text' : '';
    queueMutation({ type: 'unbindField', nodeId, property, staticValue });
    closeDropdown();
  }, [nodeId, property, closeDropdown]);

  return (
    <>
      <button
        ref={btnRef}
        onClick={openDropdown}
        title={isBound ? `Bound to ${currentBinding}` : `Bind ${property} to collection field`}
        className={`shrink-0 inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium cursor-pointer transition-all ${
          isBound
            ? 'bg-purple-600/20 text-purple-300 hover:bg-purple-600/30 border border-purple-500/30'
            : 'text-[var(--text-disabled)] hover:text-[var(--text-secondary)] hover:bg-[var(--grid-line)]'
        }`}
      >
        {isBound ? (
          <>
            <span className="text-purple-400">&#x26A1;</span>
            <span className="truncate max-w-[60px]">{boundField?.name ?? currentBinding}</span>
          </>
        ) : (
          <span title="Bind to CMS field">&#x1F50C;</span>
        )}
      </button>

      {/* Dropdown portal */}
      {dropdownOpen && createPortal(
        <>
          {/* Backdrop */}
          <div className="fixed inset-0 z-50" onClick={closeDropdown} />

          {/* Menu */}
          <div
            className="fixed bg-[var(--dropdown-bg)] shadow-[var(--shadow-lg)] rounded-[var(--radius-md)] py-1.5 z-51 min-w-[160px] border border-[var(--border-light)]"
            style={{ left: dropdownPos.x, top: dropdownPos.y }}
          >
            {/* Header */}
            <div className="px-3 py-1.5 text-[10px] font-bold text-[var(--text-disabled)] uppercase">
              Bind {property}
            </div>

            {/* Field options */}
            {fields.map(field => (
              <button
                key={field.id}
                onClick={() => handleBind(field.id)}
                className={`w-[calc(100%-8px)] mx-1 flex items-center gap-2 px-2.5 py-1.5 rounded-[var(--radius-sm)] text-left cursor-pointer transition-colors ${
                  currentBinding === field.id
                    ? 'bg-purple-600/20 text-purple-300'
                    : 'hover:bg-[var(--accent)] text-[var(--text-primary)] hover:text-white'
                }`}
              >
                <span className="text-xs font-medium">{field.name}</span>
                <span className="text-[10px] text-[var(--text-disabled)] ml-auto">{field.type}</span>
              </button>
            ))}

            {/* Unbind option */}
            {isBound && (
              <>
                <div className="h-px bg-white/10 mx-2 my-1" />
                <button
                  onClick={handleUnbind}
                  className="w-[calc(100%-8px)] mx-1 flex items-center gap-2 px-2.5 py-1.5 rounded-[var(--radius-sm)] text-left cursor-pointer transition-colors hover:bg-red-600/20 text-red-400"
                >
                  <span className="text-xs font-medium">Unbind</span>
                </button>
              </>
            )}

            {fields.length === 0 && (
              <div className="px-3 py-2 text-[10px] text-[var(--text-disabled)]">
                No fields in collection
              </div>
            )}
          </div>
        </>,
        document.body,
      )}
    </>
  );
}

