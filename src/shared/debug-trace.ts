// debug-trace.ts — Records every action in the builder for debugging.
//
// Usage anywhere in the codebase:
//   trace.action('drag:start', { nodeId: 'hero', mouse: {x: 100, y: 200} })
//   trace.before('code', codeString)
//   trace.after('code', newCodeString)
//   trace.fn('generator.updateNodeStyles', { nodeId: 'hero', styles: { left: '50px' } })
//   trace.dom('style-change', { nodeId: 'hero', prop: 'left', from: '10px', to: '50px' })
//   trace.error('drag:move', error)
//
// Dump the trace:
//   trace.dump()           → logs to console
//   trace.toJSON()         → returns JSON string (paste to Claude)
//   trace.download()       → downloads as .json file
//   Cmd+Shift+D            → auto-dumps to console + downloads file
//
// Zero-cost when disabled:
//   trace.enabled = false  → all methods become no-ops

export interface TraceEntry {
  ts: number;              // timestamp (ms since page load)
  type: 'action' | 'fn' | 'before' | 'after' | 'dom' | 'error' | 'state';
  category: string;        // e.g., 'drag:start', 'generator.updateNodeStyles'
  data: any;               // payload
}

class DebugTrace {
  /** Whether trace is enabled at all (false = all methods are no-ops) */
  enabled = true;

  /** Whether we're actively recording (record/stop toggle) */
  recording = false;

  private buffer: TraceEntry[] = [];
  private recordingBuffer: TraceEntry[] = [];
  private ringBuffer: TraceEntry[] = [];
  private maxSize = 10000;
  private ringSize = 1000;
  private startTime = performance.now();
  private onRecordingChange: ((recording: boolean) => void) | null = null;

  // Track before/after pairs
  private pendingBefore: Map<string, any> = new Map();

  // ─── Record / Stop ───────────────────────────────────────────────────

  /** Start recording. Clears both buffers so only fresh entries are captured. */
  startRecording(): void {
    this.recordingBuffer = [];
    this.buffer = [];
    this.recording = true;
    this.onRecordingChange?.(true);
    console.log('%c⏺ Recording started — reproduce the issue, then press Cmd+Shift+D to stop and dump', 'color: #ef4444; font-weight: bold; font-size: 14px');
  }

  /** Stop recording and dump. Returns the recording. Keeps recordingBuffer intact for saveRecording(). */
  stopRecording(): TraceEntry[] {
    this.recording = false;
    this.onRecordingChange?.(false);
    const entries = [...this.recordingBuffer];
    console.log(`%c⏹ Recording stopped — ${entries.length} entries captured`, 'color: #10b981; font-weight: bold; font-size: 14px');
    return entries;
  }

  /** Subscribe to recording state changes (for UI indicator) */
  onRecordingStateChange(fn: (recording: boolean) => void): () => void {
    this.onRecordingChange = fn;
    return () => { this.onRecordingChange = null; };
  }

  /** Save recording to a file in the project root via Vite dev server */
  async saveRecording(): Promise<void> {
    // Always use recordingBuffer — it holds the last recording's entries
    // (stopRecording sets this.recording=false but keeps recordingBuffer intact)
    const entries = this.recordingBuffer.length > 0 ? this.recordingBuffer : this.getEntries();
    const json = JSON.stringify({
      type: 'debug-recording',
      capturedAt: new Date().toISOString(),
      entryCount: entries.length,
      duration: entries.length > 0
        ? `${((entries[entries.length - 1].ts - entries[0].ts) / 1000).toFixed(2)}s`
        : '0s',
      entries,
    }, null, 2);

    try {
      const res = await fetch(`${import.meta.env.BASE_URL}__debug_save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: json,
      });
      if (res.ok) {
        console.log('%c📁 Trace saved to debug-trace.json at project root', 'color: #10b981; font-weight: bold');
      } else {
        console.error('Failed to save trace:', res.statusText);
        // Fallback: download
        this.downloadFallback(json);
      }
    } catch {
      // Fallback if dev server plugin not available
      this.downloadFallback(json);
    }
  }

  private downloadFallback(json: string): void {
    console.log('%c⚠ Dev server plugin not available, downloading instead', 'color: #f59e0b');
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'debug-trace.json';
    a.click();
    URL.revokeObjectURL(url);
  }

  // ─── Recording ───────────────────────────────────────────────────────

  /** Record a user/system action */
  action(category: string, data?: any): void {
    this.add('action', category, data);
  }

  /** Record a function call with its arguments */
  fn(fnName: string, args?: any): void {
    this.add('fn', fnName, args);
  }

  /** Record state before a mutation (call .after() after the mutation) */
  before(key: string, value: any): void {
    if (!this.enabled) return;
    this.pendingBefore.set(key, this.snapshot(value));
  }

  /** Record state after a mutation (pairs with .before()) */
  after(key: string, value: any): void {
    if (!this.enabled) return;
    const beforeVal = this.pendingBefore.get(key);
    this.pendingBefore.delete(key);

    if (typeof beforeVal === 'string' && typeof value === 'string') {
      // For code strings: store a compact diff (first changed line)
      this.add('after', key, {
        before: this.truncate(beforeVal, 200),
        after: this.truncate(this.snapshot(value), 200),
        changed: beforeVal !== value,
        diff: this.simpleDiff(beforeVal, value as string),
      });
    } else {
      this.add('after', key, {
        before: beforeVal,
        after: this.snapshot(value),
      });
    }
  }

  /** Record a DOM mutation */
  dom(description: string, data?: any): void {
    this.add('dom', description, data);
  }

  /** Record a state change */
  state(description: string, data?: any): void {
    this.add('state', description, data);
  }

  /** Record an error */
  error(category: string, err: any): void {
    // Always log to DevTools console for immediate visibility
    console.error(`[${category}]`, err?.message || String(err), err);
    // `stack` is a string on live Error objects, but errors that crossed the
    // bridge arrive structured-cloned as plain objects whose stack may
    // already be an ARRAY (the sandbox's trace payload shape) — calling
    // .split on it threw "err?.stack?.split is not a function" INSIDE this
    // error handler, masking the original failure (live find 2026-07-19:
    // the export capture's failed dynamic import).
    const rawStack = err?.stack;
    const stack = typeof rawStack === 'string'
      ? rawStack.split('\n').slice(0, 5)
      : Array.isArray(rawStack) ? rawStack.slice(0, 5) : undefined;
    this.add('error', category, {
      message: err?.message || String(err),
      stack,
    });
  }

  // ─── Output ──────────────────────────────────────────────────────────

  /** Dump last N entries to console */
  dump(count: number = 50): void {
    const entries = this.buffer.slice(-count);
    console.group(`🔍 Debug Trace (last ${entries.length} of ${this.buffer.length})`);

    for (const entry of entries) {
      const time = `+${(entry.ts / 1000).toFixed(3)}s`;
      const icon = {
        action: '▶',
        fn: '⚡',
        before: '📋',
        after: '📝',
        dom: '🏗',
        error: '❌',
        state: '💾',
      }[entry.type] || '•';

      const style = entry.type === 'error'
        ? 'color: #ef4444; font-weight: bold'
        : entry.type === 'action'
          ? 'color: #3b82f6; font-weight: bold'
          : 'color: #94a3b8';

      console.log(`%c${icon} ${time} [${entry.type}] ${entry.category}`, style, entry.data ?? '');
    }

    console.groupEnd();
  }

  /** Get full trace as JSON string */
  toJSON(): string {
    return JSON.stringify({
      totalEntries: this.buffer.length,
      sessionDuration: `${((performance.now() - this.startTime) / 1000).toFixed(1)}s`,
      entries: this.buffer.slice(-200), // last 200 entries
    }, null, 2);
  }

  /** Download trace as .json file */
  download(): void {
    const json = this.toJSON();
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `debug-trace-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  /** Clear the buffer */
  clear(): void {
    this.buffer = [];
    this.pendingBefore.clear();
  }

  /** Get raw entries */
  getEntries(): TraceEntry[] {
    return [...this.buffer];
  }

  /** Get last N entries from always-on ring buffer (for error reports) */
  getRecentEntries(): TraceEntry[] {
    return [...this.ringBuffer];
  }

  /** Get entries filtered by type */
  getByType(type: TraceEntry['type']): TraceEntry[] {
    return this.buffer.filter(e => e.type === type);
  }

  /** Get entries filtered by category prefix */
  getByCategory(prefix: string): TraceEntry[] {
    return this.buffer.filter(e => e.category.startsWith(prefix));
  }

  // ─── Private ─────────────────────────────────────────────────────────

  private add(type: TraceEntry['type'], category: string, data?: any): void {
    if (!this.enabled) return;

    const entry: TraceEntry = {
      ts: performance.now() - this.startTime,
      type,
      category,
      data: data !== undefined ? this.snapshot(data) : undefined,
    };

    // Always add to main buffer. AMORTISED trim: the old `slice(-maxSize)` ran
    // on EVERY call once full, allocating a fresh 10k-entry array each time.
    // Let it overrun by a slack window and trim once per window instead.
    this.buffer.push(entry);
    if (this.buffer.length > this.maxSize + 2000) {
      this.buffer = this.buffer.slice(-this.maxSize);
    }

    // Always-on ring buffer — last `ringSize` entries, auto-attached to error
    // logs. `shift()` is O(n) per call once full; chunk-drop instead.
    this.ringBuffer.push(entry);
    if (this.ringBuffer.length > this.ringSize + 200) {
      this.ringBuffer = this.ringBuffer.slice(-this.ringSize);
    }

    // If recording, also add to recording buffer
    if (this.recording) {
      this.recordingBuffer.push(entry);
    }

    // Ferry to parent when running inside the sandbox iframe so iframe-side
    // events land in the parent's unified timeline. Skip 'before'/'after'
    // pairs — those are local helpers that don't survive serialization.
    if (typeof window !== 'undefined' && window.parent !== window && (type === 'action' || type === 'fn' || type === 'dom' || type === 'error' || type === 'state')) {
      try {
        window.parent.postMessage(
          { __sandbox: true, payload: { type: 'traceEvent', traceType: type, category, data: entry.data } },
          '*',
        );
      } catch {
        // Same-origin restriction or detached parent — silently drop.
      }
    }
  }

  /** Deep-clone data to prevent mutation after recording */
  private snapshot(value: any): any {
    if (value === null || value === undefined) return value;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;

    // Don't clone DOM elements — just record their ID
    if (value instanceof HTMLElement) {
      return `<${value.tagName.toLowerCase()} data-node-id="${value.getAttribute('data-node-id') || '?'}">`;
    }

    // Don't clone Maps — convert to object
    if (value instanceof Map) {
      const obj: Record<string, any> = {};
      for (const [k, v] of value) obj[k] = this.snapshot(v);
      return obj;
    }

    // Don't clone Sets — convert to array
    if (value instanceof Set) return [...value];

    // FAST PATH: a flat object of primitives is the overwhelmingly common trace
    // payload ({ nodeId, vpId, count, … }). A JSON round-trip for those cost a
    // full serialize+parse PER TRACE CALL — with ~1,000 events per undo on a
    // vector-heavy page (482 of them one-per-SVG-node) that was a dominant
    // share of the keystroke ("undo super slow with all those svg",
    // 2026-08-07). A shallow copy is equivalent for this shape and ~free.
    if (Object.getPrototypeOf(value) === Object.prototype) {
      const out: Record<string, any> = {};
      let flat = true;
      for (const k in value) {
        const v = (value as Record<string, any>)[k];
        const t = typeof v;
        if (v === null || t === 'string' || t === 'number' || t === 'boolean' || t === 'undefined') {
          out[k] = v;
        } else { flat = false; break; }
      }
      if (flat) return out;
    }

    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return String(value);
    }
  }

  /** Truncate long strings */
  private truncate(str: string, maxLen: number): string {
    if (str.length <= maxLen) return str;
    return str.slice(0, maxLen) + `... (${str.length} chars)`;
  }

  /** Find first line that differs between two strings */
  private simpleDiff(a: string, b: string): string | null {
    const linesA = a.split('\n');
    const linesB = b.split('\n');
    for (let i = 0; i < Math.max(linesA.length, linesB.length); i++) {
      if (linesA[i] !== linesB[i]) {
        return `Line ${i + 1}: "${this.truncate(linesA[i] || '(deleted)', 80)}" → "${this.truncate(linesB[i] || '(added)', 80)}"`;
      }
    }
    return null;
  }
}

// ─── Singleton ─────────────────────────────────────────────────────────────

export const trace = new DebugTrace();

// ─── Keyboard shortcut: Cmd+Shift+D to dump ────────────────────────────────

/**
 * Save the current JSX code to debug-code.jsx at project root.
 * Called from DebugToolbar or automatically when recording stops.
 */
export async function saveDebugCode(code: string, filename = 'debug-code.jsx'): Promise<void> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}__debug_code`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', 'X-Debug-Filename': filename },
      body: code,
    });
    if (res.ok) {
      console.log(`%c📋 Code snapshot saved to debug_output/${filename}`, 'color: #06b6d4; font-weight: bold');
    }
  } catch {
    console.warn('Could not save debug code (dev server plugin not available)');
  }
}

/**
 * Save ALL project files to debug_output/project/ with directory structure preserved.
 * Called from DebugToolbar when saving debug output.
 */
export async function saveDebugProjectFiles(files: Record<string, string>): Promise<void> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}__debug_project`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(files),
    });
    if (res.ok) {
      const count = Object.keys(files).length;
      console.log(`%c📁 ${count} project files saved to debug_output/project/`, 'color: #06b6d4; font-weight: bold');
    }
  } catch {
    console.warn('Could not save project files (dev server plugin not available)');
  }
}

if (typeof window !== 'undefined') {
  (window as any).__trace = trace;
  (window as any).__saveCode = saveDebugCode;
}

// ─── DOM Mutation Observer (optional — call trace.observeDOM(element)) ──────

/** Pause/resume DOM observation. Set true during bulk DOM patching to avoid flooding the trace buffer. */
let _domObserverPaused = false;
export function pauseDOMObserver() { _domObserverPaused = true; }
export function resumeDOMObserver() { _domObserverPaused = false; }

export function observeDOM(container: HTMLElement): () => void {
  if (!trace.enabled) return () => {};

  const observer = new MutationObserver((mutations) => {
    if (_domObserverPaused) return;
    for (const mutation of mutations) {
      // NOTE: attr-change intentionally NOT logged — floods buffer during DOM diff (1600+ patches).
      // Use renderNodes/patchChildren timing traces instead.

      if (mutation.type === 'childList') {
        const parentId = (mutation.target as HTMLElement).getAttribute?.('data-node-id');
        if (mutation.addedNodes.length > 0) {
          trace.dom('child-added', {
            parentId,
            added: Array.from(mutation.addedNodes).map(n =>
              (n as HTMLElement).getAttribute?.('data-node-id') || n.nodeName
            ),
          });
        }
        if (mutation.removedNodes.length > 0) {
          trace.dom('child-removed', {
            parentId,
            removed: Array.from(mutation.removedNodes).map(n =>
              (n as HTMLElement).getAttribute?.('data-node-id') || n.nodeName
            ),
          });
        }
      }

      if (mutation.type === 'characterData') {
        const parentEl = mutation.target.parentElement;
        const nodeId = parentEl?.getAttribute('data-node-id');
        trace.dom('text-change', {
          nodeId,
          oldValue: mutation.oldValue?.slice(0, 100),
          newValue: mutation.target.textContent?.slice(0, 100),
        });
      }
    }
  });

  observer.observe(container, {
    attributes: true,
    attributeOldValue: true,
    childList: true,
    characterData: true,
    characterDataOldValue: true,
    subtree: true,
  });

  trace.action('dom-observer:start', { container: container.getAttribute('data-node-id') || 'content' });

  return () => observer.disconnect();
}
