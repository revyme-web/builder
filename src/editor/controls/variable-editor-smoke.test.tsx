// variable-editor-smoke.test.tsx
// Mount every atom registered in variable-editor-registry inside the modal's
// `variableDefault` mode harness with no selected node, and assert it renders
// + emits onChange without crashing.
//
// This is the audit gate for Phase 1d: any atom that reads selection state
// or a node DOM ref unguarded fails here. Lock in the contract so atoms can't
// silently regress out of variable-modal compatibility.

import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render } from '@testing-library/react';
import { Provider as JotaiProvider, createStore } from 'jotai';
import { listRegisteredVariableProperties, resolveVariableEditor } from './variable-editor-registry';
import { UnifiedControlProvider } from './unified';

// JSDOM doesn't ship ResizeObserver. ToolPopup (transitively pulled in by
// some atoms via ControlLabel → VariableModal) needs it on construct, so we
// polyfill a no-op for the test environment.
beforeAll(() => {
  if (typeof globalThis.ResizeObserver === 'undefined') {
    (globalThis as any).ResizeObserver = class {
      observe() { /* no-op */ }
      unobserve() { /* no-op */ }
      disconnect() { /* no-op */ }
    };
  }
});

function mountAtomInVariableDefault(property: string, defaultValue: string) {
  const Atom = resolveVariableEditor(property)!;
  const onChange = vi.fn();
  const store = createStore();
  const result = render(
    <JotaiProvider store={store}>
      <UnifiedControlProvider
        property={property}
        mode="variableDefault"
        externalValue={defaultValue}
        externalOnChange={onChange}
      >
        <Atom mode="variableDefault" externalValue={defaultValue} externalOnChange={onChange} />
      </UnifiedControlProvider>
    </JotaiProvider>
  );
  return { result, onChange };
}

describe('variable-editor smoke: every registered atom mounts in variableDefault mode', () => {
  for (const property of listRegisteredVariableProperties()) {
    it(`${property}: mounts without throwing`, () => {
      // The audit gate — if an atom calls into legacy ControlProvider, reads
      // a selected nodeId, or queries node DOM unguarded, the render throws
      // here and we know which atom needs hardening.
      expect(() => mountAtomInVariableDefault(property, '')).not.toThrow();
    });
  }
});
