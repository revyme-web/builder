// GoogleFormEmbed — Code component template (Google Forms iframe with placeholder fallback).

export const GOOGLE_FORM_EMBED_COMPONENT = `'use client';

/** @label "Google Form" */
/** @comment "Embed a Google Form by ID — get the 'e/...' ID from the form's prefilled link or share dialog" */
/** @defaultWidth 600 */
/** @defaultHeight 400 */
/** @controls {
  "formId": { "type": "text", "label": "Form ID", "default": "", "placeholder": "ID after /forms/d/e/" }
} */

import { withResponsiveProps } from '@revyme/runtime';

function GoogleFormEmbed({
  formId = '',
  ...props
}) {
  const wrapperStyle = { width: '100%', height: '100%',  position: 'relative', overflow: 'hidden', ...props.style };

  if (!formId) {
    return (
      <div data-id={props['data-id']} data-name={props['data-name']}
           style={{ ...wrapperStyle, display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: '#f8f5ff', textAlign: 'center', padding: '24px' }}>
        <div style={{ fontFamily: 'sans-serif', color: '#1f2937' }}>
          <div style={{ fontSize: '32px', marginBottom: '12px' }}>📋</div>
          <div style={{ fontSize: '16px', fontWeight: 600, marginBottom: '6px', color: '#7c3aed' }}>Google Form</div>
          <div style={{ fontSize: '13px', color: '#6b7280', maxWidth: '280px', lineHeight: 1.5 }}>
            Set your Google Form ID in the Properties panel to load the form.
          </div>
        </div>
      </div>
    );
  }

  const src = 'https://docs.google.com/forms/d/e/' + formId + '/viewform?embedded=true';

  return (
    <div data-id={props['data-id']} data-name={props['data-name']} style={wrapperStyle}>
      <iframe
        src={src}
        style={{ width: '100%', height: '100%', border: 0, display: 'block' }}
        title="Google Form"
      />
    </div>
  );
}

export default withResponsiveProps(GoogleFormEmbed);
`;
