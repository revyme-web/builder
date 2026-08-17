// SoundCloudEmbed — Code component template (SoundCloud track/playlist player).

export const SOUNDCLOUD_EMBED_COMPONENT = `'use client';

/** @label "SoundCloud" */
/** @comment "Embed a SoundCloud track or playlist by URL" */
/** @defaultWidth 600 */
/** @defaultHeight 400 */
/** @controls {
  "trackUrl": { "type": "text", "label": "Track URL", "default": "https://soundcloud.com/forss/flickermood", "placeholder": "Full soundcloud.com URL" },
  "autoplay": { "type": "toggle", "label": "Autoplay", "default": false },
  "visual": { "type": "toggle", "label": "Visual Mode", "default": true },
  "color": { "type": "color", "label": "Accent", "default": "#ff5500" }
} */

import { withResponsiveProps } from '@revyme/runtime';

function SoundCloudEmbed({
  trackUrl = 'https://soundcloud.com/forss/flickermood',
  autoplay = false, visual = true, color = '#ff5500',
  ...props
}) {
  const params = new URLSearchParams();
  params.set('url', trackUrl);
  params.set('color', color.replace('#', ''));
  if (autoplay) params.set('auto_play', 'true');
  if (visual) params.set('visual', 'true');
  const src = 'https://w.soundcloud.com/player/?' + params.toString();
  return (
    <div data-id={props['data-id']} data-name={props['data-name']}
         style={{ width: '100%', height: '100%',  position: 'relative', overflow: 'hidden', ...props.style }}>
      <iframe
        src={src}
        style={{ width: '100%', height: '100%', border: 0, display: 'block' }}
        allow="autoplay"
      />
    </div>
  );
}

export default withResponsiveProps(SoundCloudEmbed);
`;
