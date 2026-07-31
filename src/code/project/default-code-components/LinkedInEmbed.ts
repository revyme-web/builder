// LinkedInEmbed — Code component template (LinkedIn post embed).

export const LINKEDIN_EMBED_COMPONENT = `'use client';

/** @label "LinkedIn" */
/** @comment "Embed a LinkedIn post by its embed URL (use Share > Embed on LinkedIn to get one)" */
/** @defaultWidth 600 */
/** @defaultHeight 400 */
/** @controls {
  "embedUrl": { "type": "text", "label": "Embed URL", "default": "https://www.linkedin.com/embed/feed/update/urn:li:share:7000000000000000000", "placeholder": "linkedin.com/embed/feed/update/urn:..." }
} */

import { withResponsiveProps } from '@revyme/runtime';

function LinkedInEmbed({
  embedUrl = 'https://www.linkedin.com/embed/feed/update/urn:li:share:7000000000000000000',
  ...props
}) {
  return (
    <div data-id={props['data-id']} data-name={props['data-name']}
         style={{ width: '100%', height: '100%', ...props.style, position: 'relative', overflow: 'hidden' }}>
      <iframe
        src={embedUrl}
        style={{ width: '100%', height: '100%', border: 0, display: 'block' }}
        allowFullScreen
      />
    </div>
  );
}

export default withResponsiveProps(LinkedInEmbed);
`;
