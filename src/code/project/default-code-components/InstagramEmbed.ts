// InstagramEmbed — Code component template (Instagram post embed).

export const INSTAGRAM_EMBED_COMPONENT = `'use client';

/** @label "Instagram" */
/** @comment "Embed an Instagram post by URL" */
/** @defaultWidth 600 */
/** @defaultHeight 400 */
/** @controls {
  "postUrl": { "type": "text", "label": "Post URL", "default": "https://www.instagram.com/p/CdYJYglDMD3/", "placeholder": "Full instagram.com/p/.../ URL" }
} */

import { withResponsiveProps } from '@revyme/runtime';

function InstagramEmbed({
  postUrl = 'https://www.instagram.com/p/CdYJYglDMD3/',
  ...props
}) {
  // Strip trailing slash + add /embed for the iframe URL
  const clean = postUrl.replace(/\\/$/, '');
  const src = clean + '/embed';
  return (
    <div data-id={props['data-id']} data-name={props['data-name']}
         style={{ width: '100%', height: '100%',  position: 'relative', overflow: 'hidden', ...props.style }}>
      <iframe
        src={src}
        style={{ width: '100%', height: '100%', border: 0, display: 'block' }}
        scrolling="no"
        allowTransparency
      />
    </div>
  );
}

export default withResponsiveProps(InstagramEmbed);
`;
