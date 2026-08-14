// CopyButton — Code component template (clipboard copy with feedback swap).
//
// On the canvas: renders the button; the click handler is stripped by the
// code component runtime (as for every code component) so copying is a
// preview/live-site behaviour. The @controls expose the copied value, both
// labels, the two state palettes (rest/copied), radius and font size;
// visual styling is baked in the root so instances stay placement-only.

export const COPY_BUTTON_COMPONENT = `'use client';

/** @label "Copy Button" */
/** @comment "Button that copies a value to the clipboard" */
/** @defaultWidth 160 */
/** @defaultHeight 48 */
/** @controls {
  "value": { "type": "text", "label": "Value To Copy", "default": "hello@revyme.app" },
  "label": { "type": "text", "label": "Button Label", "default": "Copy" },
  "copiedLabel": { "type": "text", "label": "Copied Label", "default": "Copied!" },
  "textColor": { "type": "color", "label": "Text Color", "default": "#f7f5ee" },
  "background": { "type": "color", "label": "Background", "default": "#171a16" },
  "copiedTextColor": { "type": "color", "label": "Copied Text Color", "default": "#f7f5ee" },
  "copiedBackground": { "type": "color", "label": "Copied Background", "default": "#16a34a" },
  "borderRadius": { "type": "number", "label": "Radius", "min": 0, "max": 100, "step": 1, "default": 100, "unit": "px" },
  "fontSize": { "type": "number", "label": "Font Size", "min": 8, "max": 40, "step": 1, "default": 13, "unit": "px" }
} */
import React, { useState } from 'react';
import { withResponsiveProps } from '@revyme/runtime';

function CopyButton({
  value = 'hello@revyme.app',
  label = 'Copy',
  copiedLabel = 'Copied!',
  textColor = '#f7f5ee',
  background = '#171a16',
  copiedTextColor = '#f7f5ee',
  copiedBackground = '#16a34a',
  borderRadius = 100,
  fontSize = 13,
  ...props
}: any) {
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
      backgroundColor: copied ? copiedBackground : background,
      color: copied ? copiedTextColor : textColor,
      border: 'none',
      borderRadius: borderRadius,
      fontSize: fontSize,
      fontFamily: "'Helvetica Neue', Arial, sans-serif",
      fontWeight: 600,
      letterSpacing: '0.02em',
      cursor: 'pointer',
      transition: 'background-color 160ms ease, color 160ms ease',
      ...props.style,
    }}>
      {copied ? copiedLabel : label}
    </button>
  );
}

export default withResponsiveProps(CopyButton);
`;
