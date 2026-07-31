// PinterestEmbed — Code component template (Pinterest pin embed via official widget script).

export const PINTEREST_EMBED_COMPONENT = `'use client';

/** @label "Pinterest" */
/** @comment "Embed a Pinterest pin by URL — uses the official pinit widget script" */
/** @defaultWidth 600 */
/** @defaultHeight 400 */
/** @controls {
  "pinUrl": { "type": "text", "label": "Pin URL", "default": "https://www.pinterest.com/pin/99360735500167749/", "placeholder": "Full pinterest.com/pin/... URL" },
  "size": { "type": "select", "label": "Size", "default": "medium", "options": [
    { "label": "Small", "value": "small" },
    { "label": "Medium", "value": "medium" },
    { "label": "Large", "value": "large" }
  ]}
} */

import { useEffect, useRef } from 'react';
import { withResponsiveProps } from '@revyme/runtime';

function PinterestEmbed({
  pinUrl = 'https://www.pinterest.com/pin/99360735500167749/',
  size = 'medium',
  ...props
}) {
  const containerRef = useRef(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    container.innerHTML = '';
    const link = document.createElement('a');
    link.setAttribute('data-pin-do', 'embedPin');
    link.setAttribute('data-pin-width', size);
    link.href = pinUrl;
    container.appendChild(link);

    if (typeof window !== 'undefined' && window.PinUtils) {
      window.PinUtils.build(container);
      return;
    }
    const existing = document.querySelector('script[src="https://assets.pinterest.com/js/pinit.js"]');
    if (!existing) {
      const script = document.createElement('script');
      script.src = 'https://assets.pinterest.com/js/pinit.js';
      script.async = true;
      script.defer = true;
      document.body.appendChild(script);
    }
  }, [pinUrl, size]);

  return (
    <div ref={containerRef} data-id={props['data-id']} data-name={props['data-name']}
         style={{ width: '100%', height: '100%', ...props.style, display: 'flex', alignItems: 'center', justifyContent: 'center' }} />
  );
}

export default withResponsiveProps(PinterestEmbed);
`;
