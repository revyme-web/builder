// VimeoEmbed — Code component template (configurable Vimeo iframe player).

export const VIMEO_EMBED_COMPONENT = `'use client';

/** @label "Vimeo" */
/** @comment "Embed a Vimeo video by ID" */
/** @defaultWidth 600 */
/** @defaultHeight 400 */
/** @controls {
  "videoId": { "type": "text", "label": "Video ID", "default": "76979871", "placeholder": "Numeric Vimeo ID" },
  "autoplay": { "type": "toggle", "label": "Autoplay", "default": false },
  "muted": { "type": "toggle", "label": "Muted", "default": false },
  "loop": { "type": "toggle", "label": "Loop", "default": false }
} */

import { withResponsiveProps } from '@revyme/runtime';

function VimeoEmbed({
  videoId = '76979871', autoplay = false, muted = false, loop = false,
  ...props
}) {
  const params = new URLSearchParams();
  if (autoplay) params.set('autoplay', '1');
  if (muted) params.set('muted', '1');
  if (loop) params.set('loop', '1');
  const qs = params.toString();
  const src = 'https://player.vimeo.com/video/' + videoId + (qs ? '?' + qs : '');
  return (
    <div data-id={props['data-id']} data-name={props['data-name']}
         style={{ width: '100%', height: '100%', ...props.style, position: 'relative', overflow: 'hidden' }}>
      <iframe
        src={src}
        style={{ width: '100%', height: '100%', border: 0, display: 'block' }}
        allow="autoplay; fullscreen; picture-in-picture"
      />
    </div>
  );
}

export default withResponsiveProps(VimeoEmbed);
`;
