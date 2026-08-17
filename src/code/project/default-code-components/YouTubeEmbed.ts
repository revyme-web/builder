// YouTubeEmbed — Code component template (configurable YouTube iframe player).

export const YOUTUBE_EMBED_COMPONENT = `'use client';

/** @label "YouTube" */
/** @comment "Embed a YouTube video by ID with autoplay/mute/loop controls" */
/** @defaultWidth 600 */
/** @defaultHeight 400 */
/** @controls {
  "videoId": { "type": "text", "label": "Video ID", "default": "dQw4w9WgXcQ", "placeholder": "ID after watch?v=" },
  "autoplay": { "type": "toggle", "label": "Autoplay", "default": false },
  "muted": { "type": "toggle", "label": "Muted", "default": false },
  "loop": { "type": "toggle", "label": "Loop", "default": false },
  "controls": { "type": "toggle", "label": "Show Controls", "default": true }
} */

import { withResponsiveProps } from '@revyme/runtime';

function YouTubeEmbed({
  videoId = 'dQw4w9WgXcQ', autoplay = false, muted = false, loop = false, controls = true,
  ...props
}) {
  const params = new URLSearchParams();
  if (autoplay) params.set('autoplay', '1');
  if (muted) params.set('mute', '1');
  if (loop) { params.set('loop', '1'); params.set('playlist', videoId); }
  if (!controls) params.set('controls', '0');
  const qs = params.toString();
  const src = 'https://www.youtube.com/embed/' + videoId + (qs ? '?' + qs : '');
  return (
    <div data-id={props['data-id']} data-name={props['data-name']}
         style={{ width: '100%', height: '100%',  position: 'relative', overflow: 'hidden', ...props.style }}>
      <iframe
        src={src}
        style={{ width: '100%', height: '100%', border: 0, display: 'block' }}
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen"
      />
    </div>
  );
}

export default withResponsiveProps(YouTubeEmbed);
`;
