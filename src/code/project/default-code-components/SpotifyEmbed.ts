// SpotifyEmbed — Code component template (Spotify track/album/playlist embed).

export const SPOTIFY_EMBED_COMPONENT = `'use client';

/** @label "Spotify" */
/** @comment "Embed a Spotify track, album, or playlist by ID" */
/** @defaultWidth 600 */
/** @defaultHeight 400 */
/** @controls {
  "type": { "type": "select", "label": "Type", "default": "track", "options": [
    { "label": "Track", "value": "track" },
    { "label": "Album", "value": "album" },
    { "label": "Playlist", "value": "playlist" },
    { "label": "Artist", "value": "artist" },
    { "label": "Episode", "value": "episode" },
    { "label": "Show", "value": "show" }
  ]},
  "id": { "type": "text", "label": "ID", "default": "11dFghVXANMlKmJXsNCbNl", "placeholder": "ID from Spotify URL" },
  "theme": { "type": "select", "label": "Theme", "default": "0", "options": [
    { "label": "Dark", "value": "0" },
    { "label": "Light", "value": "1" }
  ]}
} */

import { withResponsiveProps } from '@revyme/runtime';

function SpotifyEmbed({
  type = 'track', id = '11dFghVXANMlKmJXsNCbNl', theme = '0',
  ...props
}) {
  const src = 'https://open.spotify.com/embed/' + type + '/' + id + '?utm_source=generator&theme=' + theme;
  return (
    <div data-id={props['data-id']} data-name={props['data-name']}
         style={{ width: '100%', height: '100%',  position: 'relative', overflow: 'hidden', ...props.style }}>
      <iframe
        src={src}
        style={{ width: '100%', height: '100%', border: 0, display: 'block' }}
        allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
        loading="lazy"
      />
    </div>
  );
}

export default withResponsiveProps(SpotifyEmbed);
`;
