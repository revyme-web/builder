// CopyButton — Code component template (clipboard copy with feedback swap).
//
// On the canvas: renders the button; the click handler is stripped by the
// code component runtime (as for every code component) so copying is a
// preview/live-site behaviour. The @controls expose the copied value and
// both labels; visual styling is baked in the root so instances stay
// placement-only.

export const COPY_BUTTON_COMPONENT = `'use client';

/** @label "Copy Button" */
/** @comment "Button that copies a value to the clipboard" */
/** @defaultWidth 160 */
/** @defaultHeight 48 */
/** @controls {
  "value": { "type": "text", "label": "Value To Copy", "default": "hello@revyme.app" },
  "label": { "type": "text", "label": "Button Label", "default": "Copy" },
  "copiedLabel": { "type": "text", "label": "Copied Label", "default": "Copied!" }
} */
import React, { useState } from 'react';
import { withResponsiveProps } from '@revyme/runtime';

function CopyButton({ value = 'hello@revyme.app', label = 'Copy', copiedLabel = 'Copied!', ...props }: any) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
    } catch (err) {
      const ta = document.createElement('textarea');
      ta.value = value;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };
  return (
    <button type="button" onClick={onCopy} {...props} style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: '100%',
      height: '100%',
      padding: '0px 20px',
      backgroundColor: copied ? '#16a34a' : '#171a16',
      color: '#f7f5ee',
      border: 'none',
      borderRadius: '9999px',
      fontFamily: "'Helvetica Neue', Arial, sans-serif",
      fontSize: '13px',
      fontWeight: 600,
      letterSpacing: '0.02em',
      cursor: 'pointer',
      transition: 'background-color 160ms ease',
      ...props.style,
    }}>
      {copied ? copiedLabel : label}
    </button>
  );
}

export default withResponsiveProps(CopyButton);
`;
