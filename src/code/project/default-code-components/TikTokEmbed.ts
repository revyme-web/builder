// TikTokEmbed — Code component template (TikTok video embed via official embed iframe).

export const TIKTOK_EMBED_COMPONENT = `'use client';

/** @label "TikTok" */
/** @comment "Embed a TikTok video by ID — drop the URL https://www.tiktok.com/@user/video/<ID>" */
/** @defaultWidth 600 */
/** @defaultHeight 400 */
/** @controls {
  "videoId": { "type": "text", "label": "Video ID", "default": "7106594312292453675", "placeholder": "Numeric ID after /video/" }
} */

import { withResponsiveProps } from '@revyme/runtime';

function TikTokEmbed({
  videoId = '7106594312292453675',
  ...props
}) {
  const src = 'https://www.tiktok.com/embed/v2/' + videoId;
  return (
    <div data-id={props['data-id']} data-name={props['data-name']}
         style={{ width: '100%', height: '100%',  position: 'relative', overflow: 'hidden', ...props.style }}>
      <iframe
        src={src}
        style={{ width: '100%', height: '100%', border: 0, display: 'block' }}
        allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
        allowFullScreen
        scrolling="no"
      />
    </div>
  );
}

export default withResponsiveProps(TikTokEmbed);
`;
