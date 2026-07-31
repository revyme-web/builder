import { useEffect, useRef, useState, useCallback } from 'react';
// @ts-ignore — no types for standalone
import { transform } from '@babel/standalone';
import { projectFS } from '@/code/project/project-fs';
import { listPageFiles, getPageSlug } from '@/code/project/active-file-store';
import { trace } from '@/shared/debug-trace';

function stripImports(code: string): string {
  return code
    .replace(/^['"]use client['"];?\s*\n?/gm, '')
    .replace(/^import\s+.*$/gm, '')
    .replace(/^gsap\.registerPlugin\(.*\);?\s*\n?/gm, '')
    .trim();
}

function isComponentFile(code: string): boolean {
  return /export\s+default\s+function/.test(code) || /^function\s+[A-Z]/m.test(code);
}

function resolveComponents(code: string): string {
  // Find all component references in the JSX (capitalized tags like <NooNoo />)
  const componentTags = new Set<string>();
  const tagRegex = /<([A-Z][A-Za-z0-9]+)[\s/]/g;
  let match;
  while ((match = tagRegex.exec(code)) !== null) {
    // Skip known globals (React fragments are already handled)
    if (match[1] !== 'AnimatePresence') {
      componentTags.add(match[1]);
    }
  }

  let componentDefs = '';
  for (const tag of componentTags) {
    const componentFile = projectFS.listFiles('components/')
      .find(f => f === `components/${tag}.tsx` || f === `components/${tag}.jsx`);

    if (componentFile) {
      let componentCode = projectFS.readFile(componentFile) ?? '';
      // Strip imports and export default
      componentCode = stripImports(componentCode);
      componentCode = componentCode.replace(/export\s+default\s+/g, '');
      // Rename variantConfig to avoid collisions between components
      // e.g. Gallery's variantConfig → Gallery_variantConfig
      componentCode = componentCode.replace(/\bvariantConfig\b/g, `${tag}_variantConfig`);
      componentDefs += componentCode + '\n\n';
    }
  }

  return componentDefs;
}

function compileJSX(jsxCode: string): string {
  const code = jsxCode.trim();

  // No containerType injection needed — source code uses real @media queries.
  // Canvas transforms @media → @container at render time.

  let wrapped: string;

  if (isComponentFile(code)) {
    // It's a component file (e.g. components/NooNoo.tsx)
    // Strip imports, rename export default function → function, alias as Page
    let cleanCode = stripImports(code);
    cleanCode = cleanCode.replace(/export\s+default\s+/g, '');

    // Find the function name to alias as Page
    const fnMatch = cleanCode.match(/function\s+([A-Z][A-Za-z0-9]*)/);
    const fnName = fnMatch?.[1] ?? 'Component';

    // Resolve any sub-components this component uses
    const subComponents = resolveComponents(cleanCode);

    // Only alias if the function isn't already named Page
    const alias = fnName === 'Page' ? '' : `\nvar Page = ${fnName};`;
    wrapped = `${subComponents}${cleanCode}${alias}`;
  } else {
    // Raw JSX page — resolve components and wrap in Page function
    const componentDefs = resolveComponents(code);
    wrapped = `${componentDefs}function Page() {\n  return (<>${code}</>);\n}`;
  }

  // Transpile JSX → JS
  const result = transform(wrapped, {
    presets: ['react'],
    filename: 'preview.jsx',
  });

  return result.code ?? '';
}

interface LivePreviewProps {
  code: string;
}

export default function LivePreview({ code }: LivePreviewProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  const pendingRef = useRef<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Resolve a slug ("/about") to a page file path, compile, and send to iframe
  const navigatePreview = useCallback((href: string, smooth?: boolean) => {
    // Parse "/about#features" → slug="/about", section="features"
    const [slug, section] = href.split('#');
    const pageSlug = slug || '/';

    // Find matching page file
    const pages = listPageFiles();
    const pageFile = pages.find(fp => getPageSlug(fp) === pageSlug);
    if (!pageFile) {
      trace.error('live-preview:navigate-not-found', { href, pageSlug });
      return;
    }

    const pageCode = projectFS.readFile(pageFile);
    if (!pageCode) return;

    trace.action('live-preview:navigate', { href, pageFile, section });

    try {
      const compiled = compileJSX(pageCode);
      const tokensCSS = projectFS.readFile('app/globals.css') || '';
      iframeRef.current?.contentWindow?.postMessage(
        { type: 'PREVIEW_CODE', compiled, tokensCSS, scrollToId: section, smooth },
        '*'
      );
    } catch (e: any) {
      trace.error('live-preview:navigate-compile-error', { message: e.message });
    }
  }, []);

  // Listen for PREVIEW_READY and PREVIEW_NAVIGATE from iframe
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (e.data?.type === 'PREVIEW_READY') {
        setReady(true);
        if (pendingRef.current !== null) {
          iframeRef.current?.contentWindow?.postMessage(
            { type: 'PREVIEW_CODE', compiled: pendingRef.current },
            '*'
          );
          pendingRef.current = null;
        }
      }
      if (e.data?.type === 'PREVIEW_NAVIGATE') {
        navigatePreview(e.data.href, e.data.smooth);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [navigatePreview]);

  // Compile and send code to iframe when it changes
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      try {
        const compiled = compileJSX(code);
        // Include tokens.css for CSS variable resolution in preview
        const tokensCSS = projectFS.readFile('app/globals.css') || '';
        if (ready && iframeRef.current?.contentWindow) {
          iframeRef.current.contentWindow.postMessage(
            { type: 'PREVIEW_CODE', compiled, tokensCSS },
            '*'
          );
        } else {
          pendingRef.current = compiled;
        }
      } catch (e: any) {
        trace.error('live-preview:compile-error', { message: e.message });
      }
    }, 300);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [code, ready]);

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative', backgroundColor: '#111' }}>
      {!ready && (
        <div style={{
          position: 'absolute', inset: 0, display: 'flex',
          alignItems: 'center', justifyContent: 'center',
          color: '#666', fontSize: 13, fontFamily: 'monospace',
          zIndex: 1,
        }}>
          Loading preview...
        </div>
      )}
      <iframe
        ref={iframeRef}
        src={`${import.meta.env.BASE_URL}preview.html`}
        style={{
          width: '100%',
          height: '100%',
          border: 'none',
          backgroundColor: '#fff',
        }}
      />
    </div>
  );
}
