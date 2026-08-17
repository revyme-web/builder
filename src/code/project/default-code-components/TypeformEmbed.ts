// TypeformEmbed — Code component template (Typeform iframe with placeholder fallback).

export const TYPEFORM_EMBED_COMPONENT = `'use client';

/** @label "Typeform" */
/** @comment "Embed a Typeform by form ID — copy the ID from your typeform URL (form.typeform.com/to/<ID>)" */
/** @defaultWidth 600 */
/** @defaultHeight 400 */
/** @controls {
  "formId": { "type": "text", "label": "Form ID", "default": "", "placeholder": "ID after typeform.com/to/" }
} */

import { withResponsiveProps } from '@revyme/runtime';

function TypeformEmbed({
  formId = '',
  ...props
}) {
  const wrapperStyle = { width: '100%', height: '100%',  position: 'relative', overflow: 'hidden', ...props.style };

  if (!formId) {
    return (
      <div data-id={props['data-id']} data-name={props['data-name']}
           style={{ ...wrapperStyle, display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: '#0a0a0a', color: '#fff', textAlign: 'center', padding: '24px' }}>
        <div style={{ fontFamily: 'sans-serif' }}>
          <div style={{ fontSize: '32px', marginBottom: '12px' }}>📝</div>
          <div style={{ fontSize: '16px', fontWeight: 600, marginBottom: '6px' }}>Typeform</div>
          <div style={{ fontSize: '13px', color: '#9ca3af', maxWidth: '280px', lineHeight: 1.5 }}>
            Set your Typeform ID in the Properties panel to load the form.
          </div>
        </div>
      </div>
    );
  }

  // Plain iframe uses just the form URL — the embed-widget query string is for
  // the official Vanilla Embed JS library, not for direct iframes.
  const src = 'https://form.typeform.com/to/' + formId;

  return (
    <div data-id={props['data-id']} data-name={props['data-name']} style={wrapperStyle}>
      <iframe
        src={src}
        style={{ width: '100%', height: '100%', border: 0, display: 'block' }}
        title="Typeform"
        allow="camera; microphone; autoplay; encrypted-media; fullscreen"
      />
    </div>
  );
}

export default withResponsiveProps(TypeformEmbed);
`;
