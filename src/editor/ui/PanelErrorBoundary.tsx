// PanelErrorBoundary.tsx — containment for editor chrome crashes.
//
// Two update-depth crashes in one day (PinConstraintLines NaN loop,
// ToolInput prop-sync loop) each unmounted the ENTIRE app because nothing
// above them caught the throw. Editor chrome (panels, selection overlays)
// must never take the canvas down with it: catch, trace, render nothing,
// and self-reset when the `resetKey` (usually the selected node) changes —
// so a crash caused by one node's pathological state clears the moment the
// user clicks elsewhere.

import { Component, type ReactNode } from 'react';
import { trace } from '@/shared/debug-trace';

interface Props {
  /** Label for the trace so dumps name the crashed surface. */
  name: string;
  /** When this changes, a crashed boundary re-arms and tries again. */
  resetKey?: string | null;
  children: ReactNode;
}

interface State {
  crashed: boolean;
  /** resetKey value at crash time — a different key re-arms. */
  crashKey?: string | null;
}

export default class PanelErrorBoundary extends Component<Props, State> {
  state: State = { crashed: false };

  static getDerivedStateFromError(): Partial<State> {
    return { crashed: true };
  }

  componentDidCatch(error: Error): void {
    this.setState({ crashKey: this.props.resetKey ?? null });
    trace.error('panel-error-boundary:crash', {
      name: this.props.name,
      resetKey: this.props.resetKey ?? null,
      error: String(error?.message ?? error).slice(0, 300),
    });
  }

  componentDidUpdate(): void {
    if (this.state.crashed && (this.props.resetKey ?? null) !== (this.state.crashKey ?? null)) {
      trace.action('panel-error-boundary:reset', { name: this.props.name, resetKey: this.props.resetKey ?? null });
      this.setState({ crashed: false, crashKey: undefined });
    }
  }

  render(): ReactNode {
    if (this.state.crashed) return null;
    return this.props.children;
  }
}
