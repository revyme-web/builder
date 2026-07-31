// FacebookEmbed — Code component template (Facebook post / page / video embed).

export const FACEBOOK_EMBED_COMPONENT = `'use client';

/** @label "Facebook" */
/** @comment "Embed a Facebook post, page, or video by URL" */
/** @defaultWidth 600 */
/** @defaultHeight 400 */
/** @controls {
  "postUrl": { "type": "text", "label": "Post URL", "default": "https://www.facebook.com/facebook/posts/10153231379946729", "placeholder": "Full facebook.com URL" },
  "showText": { "type": "toggle", "label": "Show Text", "default": true }
} */

import { withResponsiveProps } from '@revyme/runtime';

function FacebookEmbed({
  postUrl = 'https://www.facebook.com/facebook/posts/10153231379946729',
  showText = true,
  ...props
}) {
  const params = new URLSearchParams();
  params.set('href', postUrl);
  params.set('show_text', showText ? 'true' : 'false');
  params.set('width', '500');
  const src = 'https://www.facebook.com/plugins/post.php?' + params.toString();
  return (
    <div data-id={props['data-id']} data-name={props['data-name']}
         style={{ width: '100%', height: '100%', ...props.style, position: 'relative', overflow: 'hidden' }}>
      <iframe
        src={src}
        style={{ width: '100%', height: '100%', border: 0, display: 'block' }}
        scrolling="no"
        allow="autoplay; clipboard-write; encrypted-media; picture-in-picture; web-share"
      />
    </div>
  );
}

export default withResponsiveProps(FacebookEmbed);
`;
