// ComponentLivePreview.tsx — In-builder live preview of a component master.
// Compiles the component (and any nested @/components imports) in-process via
// compileCodeComponent. No iframe, no preview server — just React.

import React, { useEffect, useMemo, useState } from 'react';
import { projectFS } from '@/code/project/project-fs';
import { compileCodeComponent } from '@/canvas/code-component-runtime';
import { trace } from '@/shared/debug-trace';

interface Props {
  /** Path of the active component master (e.g. "components/Card.tsx") */
  componentFilePath: string;
}

const COMPONENT_IMPORT_RE = /import\s+(\w+)\s+from\s+['"](@\/components\/[^'"]+|components\/[^'"]+)['"]/g;

/**
 * Compile a component file plus any @/components imports it references.
 * Walks the import graph breadth-first; cycles short-circuit via the visited set.
 */
function compileWithDependencies(
  rootPath: string,
  visited: Set<string> = new Set(),
): React.ComponentType<any> | null {
  if (visited.has(rootPath)) {
    trace.action('component-live-preview:cycle', { path: rootPath });
    return null;
  }
  visited.add(rootPath);

  const code = projectFS.readFile(rootPath);
  if (!code) {
    trace.error('component-live-preview:file-missing', { path: rootPath });
    return null;
  }

  // Pre-compile every nested @/components/* import so __require can resolve them
  const extraModules: Record<string, any> = {};
  COMPONENT_IMPORT_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = COMPONENT_IMPORT_RE.exec(code)) !== null) {
    const importSpec = match[2]; // "@/components/Foo" or "components/Foo"
    const relativePath = importSpec.replace(/^@\//, '');
    const childPath = relativePath.endsWith('.tsx') ? relativePath : `${relativePath}.tsx`;
    if (!projectFS.exists(childPath)) continue;

    const ChildComponent = compileWithDependencies(childPath, visited);
    if (ChildComponent) {
      // Register under both the import spec the runtime sees AND the short form
      const shortSpec = importSpec.replace(/^@\//, '');
      extraModules[importSpec] = { default: ChildComponent };
      extraModules[shortSpec] = { default: ChildComponent };
    }
  }

  const componentName = rootPath.replace(/^components\//, '').replace(/\.tsx$/, '');
  return compileCodeComponent(code, componentName, {
    previewMode: true,
    extraModules,
    skipCache: true,
  });
}

export default function ComponentLivePreview({ componentFilePath }: Props) {
  const [version, setVersion] = useState(0);

  // Recompile whenever projectFS changes — the component itself or any of its deps
  useEffect(() => {
    const unsub = projectFS.subscribe(() => setVersion((v) => v + 1));
    return () => { unsub(); };
  }, []);

  const Compiled = useMemo(() => {
    try {
      return compileWithDependencies(componentFilePath);
    } catch (err) {
      trace.error('component-live-preview:compile-threw', { error: String(err) });
      return null;
    }
  }, [componentFilePath, version]);

  trace.fn('ComponentLivePreview.render', { componentFilePath, hasCompiled: !!Compiled, version });

  // Reset the master root's positioning so the flex-centering wrapper
  // around `<Compiled />` actually works. The generator bakes the
  // master's canvas-space coords into the root's inline `style` (e.g.
  // `position: 'absolute', left: '1135px', top: '161px'`) — at canvas
  // those values are overridden by the Renderer per-variant viewport,
  // but in preview the component renders bare and the inline coords
  // shove it to that exact pixel offset (visible bug: master ends up
  // glued to the right edge of the preview, miles below the title bar).
  //
  // Passing a `style` prop overriding via the component's `...style`
  // spread DOESN'T work in this preview pipeline — framer-motion's
  // `motion.div` and the layout/layoutId props process the style prop
  // in a way that the inline `position: 'absolute'` survives even when
  // the spread should have overwritten it. The reliable fix is a
  // scoped CSS rule with `!important` targeting the immediate
  // `data-id` child of the preview container; CSS specificity beats
  // inline-style without depending on how the generated JSX assembles
  // its style object.
  const previewScopeId = useMemo(
    () => `preview-${componentFilePath.replace(/[^a-zA-Z0-9]/g, '-')}`,
    [componentFilePath],
  );

  return (
    <div
      id={previewScopeId}
      style={{
        width: '100%', height: '100%',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'var(--bg-canvas, #1a1a2e)', overflow: 'auto', padding: 40,
      }}
    >
      <style>{`
        #${previewScopeId} > [data-id] {
          position: relative !important;
          left: auto !important;
          top: auto !important;
          right: auto !important;
          bottom: auto !important;
        }
      `}</style>
      {Compiled ? (
        <ErrorBoundary key={`${componentFilePath}#${version}`}>
          <Compiled />
        </ErrorBoundary>
      ) : (
        <div style={{ color: '#888', fontFamily: 'monospace', fontSize: 12 }}>
          Failed to compile {componentFilePath}
        </div>
      )}
    </div>
  );
}

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(err: Error) { return { error: err.message }; }
  componentDidUpdate(prevProps: any) {
    if (prevProps.children !== this.props.children && this.state.error) this.setState({ error: null });
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{
          maxWidth: 480, padding: 16, borderRadius: 8,
          background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.2)',
          color: '#fca5a5', fontFamily: 'monospace', fontSize: 11,
          whiteSpace: 'pre-wrap',
        }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>Render Error</div>
          {this.state.error}
        </div>
      );
    }
    return this.props.children;
  }
}
