// withResponsiveProps-fx.test.tsx — EMPIRICAL PIN, live find 2026-07-14:
// an Appear effect on a CODE component (Marquee) generated the full page-side
// machinery (data-instance-fx + useMotionValue + animate() + style bindings)
// but died at the component boundary: the code component's root is a plain
// div, so `opacity: <MotionValue>` arrived as an unserialisable object and
// `y` isn't CSS — the effect was silently inert on the live site.
//
// @revyme/runtime's withResponsiveProps now provides the ANIMATED-STYLE
// SOCKET (design-tool parity): when the instance style carries MotionValues or
// motion-only keys, the HOC renders a motion.div wrapper that consumes them
// (plus the placement props), handing the component a clean static style.
// No animated values → no wrapper → identical DOM to before.

import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import React from 'react';
import { withResponsiveProps } from '@revyme/runtime';
import { useMotionValue } from 'framer-motion';

function Probe(props: Record<string, any>) {
  return (
    <div data-id={props['data-id']} data-probe="root" style={props.style}>
      {props.label}
    </div>
  );
}
const Wrapped = withResponsiveProps(Probe as any) as any;

function AnimatedHarness() {
  const op = useMotionValue(0);
  const y = useMotionValue(81);
  return (
    <Wrapped
      data-id="mq-1"
      label="hi"
      style={{ opacity: op, y, width: '100%', height: '160px', flex: '0 0 auto', order: '1', backgroundColor: '#111111' }}
    />
  );
}

describe('withResponsiveProps — animated-style socket for code components', () => {
  it('static style → NO wrapper, byte-identical passthrough', () => {
    const { container } = render(
      <Wrapped data-id="mq-0" label="hi" style={{ width: '100%', height: '160px', flex: '0 0 auto' }} />,
    );
    const root = container.querySelector('[data-probe="root"]') as HTMLElement;
    // Probe root is mounted directly in the RTL container — no injected div.
    expect(root.parentElement).toBe(container);
    expect(root.style.width).toBe('100%');
    expect(root.style.height).toBe('160px');
  });

  it('MotionValue style → motion wrapper consumes animated + placement props', () => {
    const { container } = render(<AnimatedHarness />);
    const root = container.querySelector('[data-probe="root"]') as HTMLElement;
    const wrapper = root.parentElement as HTMLElement;
    // A wrapper was injected between container and component root.
    expect(wrapper).not.toBe(container);
    // The wrapper carries the animated values (motion applies them inline)…
    expect(wrapper.style.opacity).toBe('0');
    expect(wrapper.style.transform).toContain('81');
    // …and the placement props from the instance style.
    expect(wrapper.style.width).toBe('100%');
    expect(wrapper.style.height).toBe('160px');
    expect(wrapper.style.order).toBe('1');
    // The component gets a clean static style: fills the wrapper, keeps its
    // visual props, and never sees the MotionValues.
    expect(root.style.width).toBe('100%');
    expect(root.style.height).toBe('100%');
    expect(root.style.backgroundColor).toBe('rgb(17, 17, 17)');
    expect(root.style.opacity).toBe('');
    // data-id stays on the component's own root (canvas selection contract).
    expect(root.getAttribute('data-id')).toBe('mq-1');
    expect(wrapper.getAttribute('data-id')).toBeNull();
  });

  it('motion-only key with a static value also routes through the wrapper', () => {
    const { container } = render(
      <Wrapped data-id="mq-2" label="hi" style={{ y: 40, width: '200px' }} />,
    );
    const root = container.querySelector('[data-probe="root"]') as HTMLElement;
    const wrapper = root.parentElement as HTMLElement;
    expect(wrapper).not.toBe(container);
    expect(wrapper.style.transform).toContain('40');
  });

  it('wrapper split re-bases the inner root: position always lands in innerStyle as relative', () => {
    // EMPIRICAL PIN, live find 2026-07-28: a DESIGN component instance
    // (Sign Up button) inside an AnimatePresence popLayout header vanished on
    // the live site. popLayout's ref forces the HOC wrapper; the split moved
    // the instance's `position: 'relative'` onto the wrapper, so the master
    // root's canvas-tiling `position: 'absolute'` was never overridden by the
    // trailing `...style` spread — the root absolute-positioned inside a
    // zero-size wrapper and was clipped invisible. The split must hand the
    // inner component `position: 'relative'` so the root re-bases INTO the
    // wrapper box.
    const ref = React.createRef<HTMLElement>();
    // Mimic a design-master root: bakes position:absolute, spreads style last.
    function DesignRoot(props: Record<string, any>) {
      return (
        <a data-probe="design-root" style={{ position: 'absolute', width: 'max-content', ...props.style }}>
          Sign Up
        </a>
      );
    }
    const WrappedDesign = withResponsiveProps(DesignRoot as any) as any;
    const { container } = render(
      <WrappedDesign ref={ref} style={{ order: '2', flex: '0 0 auto', position: 'relative' }} />,
    );
    const root = container.querySelector('[data-probe="design-root"]') as HTMLElement;
    const wrapper = root.parentElement as HTMLElement;
    expect(wrapper).not.toBe(container);
    // Placement rode the wrapper…
    expect(wrapper.style.order).toBe('2');
    expect(wrapper.style.position).toBe('relative');
    // …and the inner root was re-based into it (absolute overridden).
    expect(root.style.position).toBe('relative');
  });

  it('a forwarded ref (scroll-effect target) hydrates against the wrapper box', () => {
    // Scroll Transform emits `ref={X}` on the instance for useScroll({target: X}).
    // A plain function component drops the ref → motion throws "Target ref is
    // defined but not hydrated". The HOC must pin it to the wrapper element.
    const ref = React.createRef<HTMLElement>();
    const { container } = render(
      <Wrapped ref={ref} data-id="mq-3" label="hi" style={{ width: '100%', height: '160px' }} />,
    );
    const root = container.querySelector('[data-probe="root"]') as HTMLElement;
    expect(ref.current).not.toBeNull();
    expect(ref.current).toBe(root.parentElement); // = the wrapper, the component's box
    expect((ref.current as HTMLElement).style.height).toBe('160px');
    // The ref prop never leaks into the component (React 19 passes it as a prop).
    expect(root.getAttribute('ref')).toBeNull();
  });
});
