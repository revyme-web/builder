// CalendlyEmbed — Code component template (Calendly scheduling iframe with placeholder fallback).

export const CALENDLY_EMBED_COMPONENT = `'use client';

/** @label "Calendly" */
/** @comment "Embed a Calendly scheduling page by URL — set the URL in the controls panel" */
/** @defaultWidth 600 */
/** @defaultHeight 400 */
/** @controls {
  "url": { "type": "text", "label": "Calendly URL", "default": "", "placeholder": "https://calendly.com/your-name/30min" },
  "hideCover": { "type": "toggle", "label": "Hide Cover Page", "default": false },
  "hideDetails": { "type": "toggle", "label": "Hide Event Details", "default": false }
} */

import { withResponsiveProps } from '@revyme/runtime';

function CalendlyEmbed({
  url = '', hideCover = false, hideDetails = false,
  ...props
}) {
  const wrapperStyle = { width: '100%', height: '100%', ...props.style, position: 'relative', overflow: 'hidden' };

  if (!url) {
    return (
      <div data-id={props['data-id']} data-name={props['data-name']}
           style={{ ...wrapperStyle, display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: '#f3f4f6', textAlign: 'center', padding: '24px' }}>
        <div style={{ fontFamily: 'sans-serif', color: '#374151' }}>
          <div style={{ fontSize: '32px', marginBottom: '12px' }}>📅</div>
          <div style={{ fontSize: '16px', fontWeight: 600, marginBottom: '6px' }}>Calendly</div>
          <div style={{ fontSize: '13px', color: '#6b7280', maxWidth: '280px', lineHeight: 1.5 }}>
            Set your Calendly URL in the Properties panel to load the scheduling widget.
          </div>
        </div>
      </div>
    );
  }

  const params = [];
  if (hideCover) params.push('hide_landing_page_details=1');
  if (hideDetails) params.push('hide_event_type_details=1');
  const src = url + (params.length ? (url.includes('?') ? '&' : '?') + params.join('&') : '');

  return (
    <div data-id={props['data-id']} data-name={props['data-name']} style={wrapperStyle}>
      <iframe
        src={src}
        style={{ width: '100%', height: '100%', border: 0, display: 'block' }}
        title="Calendly"
      />
    </div>
  );
}

export default withResponsiveProps(CalendlyEmbed);
`;
