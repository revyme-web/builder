// localize-gate.test.tsx — the gate's nesting contract.
//
// The text tool turns Localize OFF for the whole section and back ON for the
// Content row alone (user call 2026-08-10): a `:lang()` rule targets
// `[data-id]` with `!important`, and rich-text runs are spans with no
// `data-id`, so a per-locale text STYLE overrides every run in the node.
// Content is exempt because it isn't CSS at all — it routes to
// `messages/{locale}.json`.
//
// That whole arrangement rests on an inner `hidden={false}` beating an outer
// `hidden`. If the gate ever became "once hidden, always hidden", Content would
// silently lose its Localize and nothing else would fail.

import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { LocalizeGate, useLocalizeHidden } from './localize-gate';

function Probe({ id }: { id: string }) {
  return <span data-testid={id}>{String(useLocalizeHidden())}</span>;
}

const hiddenAt = (c: HTMLElement, id: string) => c.querySelector(`[data-testid="${id}"]`)?.textContent;

describe('LocalizeGate', () => {
  it('is OFF by default — an ungated control keeps its Localize', () => {
    const { container } = render(<Probe id="bare" />);
    expect(hiddenAt(container, 'bare')).toBe('false');
  });

  it('hides everything beneath it', () => {
    const { container } = render(<LocalizeGate hidden><Probe id="row" /></LocalizeGate>);
    expect(hiddenAt(container, 'row')).toBe('true');
  });

  it('an inner gate can RE-ALLOW one row — the Content arrangement', () => {
    const { container } = render(
      <LocalizeGate hidden>
        <LocalizeGate hidden={false}><Probe id="content" /></LocalizeGate>
        <Probe id="weight" />
      </LocalizeGate>,
    );
    expect(hiddenAt(container, 'content')).toBe('false');
    expect(hiddenAt(container, 'weight')).toBe('true');
  });

  it('re-allowing does not leak to later siblings', () => {
    // The exempt row must be an island: the rows after it stay gated.
    const { container } = render(
      <LocalizeGate hidden>
        <LocalizeGate hidden={false}><Probe id="content" /></LocalizeGate>
        <Probe id="family" />
        <Probe id="italic" />
      </LocalizeGate>,
    );
    expect(hiddenAt(container, 'family')).toBe('true');
    expect(hiddenAt(container, 'italic')).toBe('true');
  });

  it('reaches arbitrarily deep, not just direct children', () => {
    // Text rows sit inside ToolSection and a CreateVariableGate, so the value
    // has to survive intermediate wrappers.
    const { container } = render(
      <LocalizeGate hidden>
        <div><div><Probe id="deep" /></div></div>
      </LocalizeGate>,
    );
    expect(hiddenAt(container, 'deep')).toBe('true');
  });
});
