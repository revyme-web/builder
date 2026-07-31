// GoogleMapsEmbed — Code component template (Google Maps embed by query / place).

export const GOOGLE_MAPS_EMBED_COMPONENT = `'use client';

/** @label "Google Maps" */
/** @comment "Embed a Google Maps location by search query (no API key required)" */
/** @defaultWidth 600 */
/** @defaultHeight 400 */
/** @controls {
  "query": { "type": "text", "label": "Location", "default": "Eiffel Tower, Paris", "placeholder": "Address or place name" },
  "zoom": { "type": "number", "label": "Zoom", "min": 1, "max": 20, "default": 14, "step": 1 },
  "mapType": { "type": "select", "label": "Map Type", "default": "m", "options": [
    { "label": "Roadmap", "value": "m" },
    { "label": "Satellite", "value": "k" },
    { "label": "Hybrid", "value": "h" },
    { "label": "Terrain", "value": "p" }
  ]}
} */

import { withResponsiveProps } from '@revyme/runtime';

function GoogleMapsEmbed({
  query = 'Eiffel Tower, Paris', zoom = 14, mapType = 'm',
  ...props
}) {
  const params = new URLSearchParams();
  params.set('q', query);
  params.set('z', String(zoom));
  params.set('t', mapType);
  params.set('output', 'embed');
  const src = 'https://maps.google.com/maps?' + params.toString();
  return (
    <div data-id={props['data-id']} data-name={props['data-name']}
         style={{ width: '100%', height: '100%', ...props.style, position: 'relative', overflow: 'hidden' }}>
      <iframe
        src={src}
        style={{ width: '100%', height: '100%', border: 0, display: 'block' }}
        loading="lazy"
        referrerPolicy="no-referrer-when-downgrade"
      />
    </div>
  );
}

export default withResponsiveProps(GoogleMapsEmbed);
`;
