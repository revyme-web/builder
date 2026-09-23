// RichLocaleField.tsx — the translation panel's editor for a RICH text node.
//
// A node with inline marks is translated as ONE message of sanitized inline
// HTML (shared/rich-message.ts). reference parity: instead of a text area the
// translator gets the same kind of editor the canvas uses — bold / italic /
// underline / strike / link / font size — so a translation can move or drop
// a mark ("<strong>bonjour</strong> mon ami"). Commits on blur with the
// sanitized HTML; the caller writes the message + the canvas override.
import { useEffect, useRef, useState } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { TextStyle } from '@tiptap/extension-text-style';
import { Color } from '@tiptap/extension-color';
import { FontSize } from '@/canvas/tiptap-extensions';
import { sanitizeRichMessage } from '@/shared/rich-message';
import { trace } from '@/shared/debug-trace';

interface Props {
  label: string;
  isDefault: boolean;
  /** Sanitized inline HTML. */
  initialHtml: string;
  /** Default-locale HTML shown faded when the field is empty. */
  placeholderHtml: string;
  onCommit: (html: string) => void;
}


// The message HTML carries the DEFAULT's run styles (font-size / colour /
// family) so the canvas can paint it; inside the PANEL those must not apply —
// a 58px run made the field unreadable. Inline styles beat utility classes, so
// this scoped sheet neutralises them with !important while keeping the
// structural marks (bold / italic / underline / strike) visible.
const PANEL_RICH_CSS = `
.revyme-rich-locale-field span, .revyme-rich-default-preview span,
.revyme-rich-locale-field a, .revyme-rich-default-preview a {
  font-size: inherit !important; line-height: inherit !important; font-family: inherit !important;
  letter-spacing: normal !important; color: inherit !important; background: none !important;
  -webkit-text-fill-color: inherit !important; text-transform: none !important; opacity: 1 !important;
}
.revyme-rich-locale-field a, .revyme-rich-default-preview a { text-decoration: underline !important; }
.revyme-rich-locale-field p { margin: 0; }
`;
let panelCssInjected = false;
function ensurePanelRichCss(): void {
  if (panelCssInjected || typeof document === 'undefined') return;
  const el = document.createElement('style');
  el.setAttribute('data-revyme-rich-locale-css', '');
  el.textContent = PANEL_RICH_CSS;
  document.head.appendChild(el);
  panelCssInjected = true;
}

const BTN = 'w-6 h-6 flex items-center justify-center text-[11px] cut-corners transition-colors cursor-pointer hover:bg-[var(--bg-hover)]';

export default function RichLocaleField({ label, isDefault, initialHtml, placeholderHtml, onCommit }: Props) {
  ensurePanelRichCss();
  // The DEFAULT locale is design, not translation: its text and run styles are
  // edited on the canvas, and every translation inherits those run styles.
  if (isDefault) return <RichDefaultPreview label={label} html={initialHtml} />;
  return <RichLocaleEditor label={label} initialHtml={initialHtml} placeholderHtml={placeholderHtml} onCommit={onCommit} />;
}

function RichDefaultPreview({ label, html }: { label: string; html: string }) {
  return (
    <div className="flex flex-col gap-1.5" data-locale-field={label} data-rich-locale-field data-rich-default-preview>
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-medium text-[var(--text-secondary)]">{label}</span>
        <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-[var(--bg-hover)] text-[var(--text-disabled)]">Default</span>
      </div>
      <div
        className="revyme-rich-default-preview w-full px-2 py-2 text-xs leading-snug bg-[var(--grid-line)] border border-[var(--control-border)] [--cut-border-color:var(--control-border)] cut-corners cut-border text-[var(--text-secondary)]"
        title="Edit the default text on the canvas — translations inherit its styling"
        dangerouslySetInnerHTML={{ __html: html || '&nbsp;' }}
      />
    </div>
  );
}

function RichLocaleEditor({ label, initialHtml, placeholderHtml, onCommit }: Omit<Props, 'isDefault'>) {
  const lastCommitted = useRef(initialHtml);
  const [, forceRender] = useState(0);
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: false, bulletList: false, orderedList: false, listItem: false,
        blockquote: false, codeBlock: false, horizontalRule: false,
        hardBreak: { keepMarks: true },
      }),
      TextStyle,
      Color,
      FontSize,
    ],
    content: initialHtml ? `<p>${initialHtml}</p>` : '<p></p>',
    editorProps: {
      attributes: {
        class: 'revyme-rich-locale-field outline-none min-h-[40px] text-xs leading-snug px-2 py-2',
        'data-locale-field': label,
      },
    },
    onSelectionUpdate: () => forceRender((n) => n + 1),
    onTransaction: () => forceRender((n) => n + 1),
  });

  // External change (locale switch / undo) → reload the editor content.
  useEffect(() => {
    if (!editor) return;
    if (initialHtml === lastCommitted.current) return;
    lastCommitted.current = initialHtml;
    editor.commands.setContent(initialHtml ? `<p>${initialHtml}</p>` : '<p></p>', { emitUpdate: false });
  }, [editor, initialHtml]);

  const commit = () => {
    if (!editor) return;
    const html = sanitizeRichMessage(editor.getHTML());
    if (html === lastCommitted.current) return;
    lastCommitted.current = html;
    trace.action('rich-locale-field:commit', { label, html: html.slice(0, 60) });
    onCommit(html);
  };

  const setLink = () => {
    if (!editor) return;
    const prev = editor.getAttributes('link').href as string | undefined;
    const href = window.prompt('Link URL', prev ?? 'https://');
    if (href === null) return;
    if (!href.trim()) { editor.chain().focus().unsetLink().run(); return; }
    editor.chain().focus().extendMarkRange('link').setLink({ href: href.trim() }).run();
  };

  const isEmpty = !!editor && editor.getText().trim() === '';

  return (
    <div className="flex flex-col gap-1.5" data-locale-field={label} data-rich-locale-field>
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-medium text-[var(--text-secondary)]">{label}</span>
      </div>
      <div
        className="relative w-full bg-[var(--grid-line)] border border-[var(--control-border)] [--cut-border-color:var(--control-border)] cut-corners cut-border text-[var(--text-primary)]"
        onKeyDown={(e) => { e.stopPropagation(); }}
        onBlur={(e) => {
          // Commit when focus leaves the whole field (toolbar clicks stay inside).
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) commit();
        }}
      >
        <div className="flex items-center gap-0.5 px-1 pt-1 border-b border-[var(--border-light)] pb-1">
          <button type="button" tabIndex={-1} title="Bold" className={`${BTN} font-bold ${editor?.isActive('bold') ? 'bg-[var(--bg-hover)]' : ''}`} onMouseDown={(e) => e.preventDefault()} onClick={() => editor?.chain().focus().toggleBold().run()}>B</button>
          <button type="button" tabIndex={-1} title="Italic" className={`${BTN} italic ${editor?.isActive('italic') ? 'bg-[var(--bg-hover)]' : ''}`} onMouseDown={(e) => e.preventDefault()} onClick={() => editor?.chain().focus().toggleItalic().run()}>I</button>
          <button type="button" tabIndex={-1} title="Underline" className={`${BTN} underline ${editor?.isActive('underline') ? 'bg-[var(--bg-hover)]' : ''}`} onMouseDown={(e) => e.preventDefault()} onClick={() => editor?.chain().focus().toggleUnderline().run()}>U</button>
          <button type="button" tabIndex={-1} title="Strikethrough" className={`${BTN} line-through ${editor?.isActive('strike') ? 'bg-[var(--bg-hover)]' : ''}`} onMouseDown={(e) => e.preventDefault()} onClick={() => editor?.chain().focus().toggleStrike().run()}>S</button>
          <button type="button" tabIndex={-1} title="Link" className={`${BTN} ${editor?.isActive('link') ? 'bg-[var(--bg-hover)]' : ''}`} onMouseDown={(e) => e.preventDefault()} onClick={setLink}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.5 1.5" /><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.5-1.5" /></svg>
          </button>
        </div>
        {isEmpty && placeholderHtml && (
          <div className="revyme-rich-default-preview pointer-events-none absolute left-2 top-[34px] right-2 text-xs leading-snug text-[var(--text-disabled)] truncate" dangerouslySetInnerHTML={{ __html: placeholderHtml }} />
        )}
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}
