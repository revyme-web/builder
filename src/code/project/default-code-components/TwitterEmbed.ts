// TwitterEmbed — Code component template (X / Twitter tweet embed via official widget script).

export const TWITTER_EMBED_COMPONENT = `'use client';

/** @label "Twitter / X" */
/** @comment "Embed a tweet by URL — uses the official platform.twitter.com widget" */
/** @defaultWidth 600 */
/** @defaultHeight 400 */
/** @controls {
  "tweetUrl": { "type": "text", "label": "Tweet URL", "default": "https://twitter.com/jack/status/20", "placeholder": "Full tweet URL" },
  "theme": { "type": "select", "label": "Theme", "default": "light", "options": [
    { "label": "Light", "value": "light" },
    { "label": "Dark", "value": "dark" }
  ]},
  "align": { "type": "select", "label": "Align", "default": "center", "options": [
    { "label": "Left", "value": "left" },
    { "label": "Center", "value": "center" },
    { "label": "Right", "value": "right" }
  ]}
} */

import { useEffect, useRef } from 'react';
import { withResponsiveProps } from '@revyme/runtime';

function TwitterEmbed({
  tweetUrl = 'https://twitter.com/jack/status/20',
  theme = 'light', align = 'center',
  ...props
}) {
  const containerRef = useRef(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    container.innerHTML = '';
    const blockquote = document.createElement('blockquote');
    blockquote.className = 'twitter-tweet';
    blockquote.setAttribute('data-theme', theme);
    blockquote.setAttribute('data-align', align);
    const link = document.createElement('a');
    link.href = tweetUrl;
    blockquote.appendChild(link);
    container.appendChild(blockquote);

    if (typeof window !== 'undefined' && window.twttr && window.twttr.widgets) {
      window.twttr.widgets.load(container);
      return;
    }
    const existing = document.querySelector('script[src="https://platform.twitter.com/widgets.js"]');
    if (!existing) {
      const script = document.createElement('script');
      script.src = 'https://platform.twitter.com/widgets.js';
      script.async = true;
      document.body.appendChild(script);
    }
  }, [tweetUrl, theme, align]);

  return (
    <div ref={containerRef} data-id={props['data-id']} data-name={props['data-name']}
         style={{ width: '100%', height: '100%', ...props.style, overflow: 'auto' }} />
  );
}

export default withResponsiveProps(TwitterEmbed);
`;
