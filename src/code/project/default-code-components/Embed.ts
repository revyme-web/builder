// Embed — Code component template (generic iframe / embed-code drop).
//
// Two ways in, because the two things people paste are different:
//   · a URL            → `<iframe src>`
//   · an embed snippet → `<iframe srcDoc>` (YouTube, Maps, Spotify, a widget
//     with its own <script>…)
//
// srcDoc rather than dangerouslySetInnerHTML: React does not execute a
// <script> it injects into the page, so an embed snippet pasted inline
// would silently render nothing. Inside an iframe document the scripts run
// normally AND stay off the host page, which is also the safer place for
// third-party code to live.
//
// On the CANVAS the iframe is replaced by a static placard. An editor full
// of live third-party frames is slow, and worse, an iframe swallows pointer
// events — the node becomes almost impossible to select or drag. The real
// frame loads in preview and on the published site.

export const EMBED_COMPONENT = `'use client';

/** @label "Embed" */
/** @comment "Embed any URL or paste an embed code — renders in an iframe" */
/** @defaultWidth 560 */
/** @defaultHeight 315 */
/** @controls {
  "url": { "type": "text", "label": "URL", "default": "", "placeholder": "https://example.com" },
  "embedCode": { "type": "text", "label": "Or Embed Code", "default": "", "placeholder": "<iframe …> or <script …>" },
  "title": { "type": "text", "label": "Title", "default": "Embedded content" },
  "allowFullscreen": { "type": "toggle", "label": "Allow Fullscreen", "default": true },
  "allowScroll": { "type": "toggle", "label": "Allow Scroll", "default": true },
  "background": { "type": "color", "label": "Background", "default": "#ffffff" },
  "borderRadius": { "type": "number", "label": "Radius", "min": 0, "max": 100, "step": 1, "default": 0, "unit": "px" }
} */

import React from 'react';
import { withResponsiveProps, useStaticCanvas } from '@revyme/runtime';

function Embed({
  url = '',
  embedCode = '',
  title = 'Embedded content',
  allowFullscreen = true,
  allowScroll = true,
  background = '#ffffff',
  borderRadius = 0,
  ...props
}: any) {
  const isCanvas = useStaticCanvas();
  const wrapperStyle = {
    width: '100%',
    height: '100%',
    position: 'relative',
    overflow: 'hidden',
    backgroundColor: background,
    borderRadius: borderRadius,
    ...props.style,
  };

  const hasSource = Boolean(url || embedCode);

  if (!hasSource || isCanvas) {
    return (
      <div data-id={props['data-id']} data-name={props['data-name']} style={{
        ...wrapperStyle,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: hasSource ? background : '#f3f4f6',
        textAlign: 'center',
        padding: '24px',
      }}>
        <div style={{ fontFamily: 'sans-serif', color: '#374151' }}>
          <div style={{ fontSize: '28px', marginBottom: '10px' }}>🔗</div>
          <div style={{ fontSize: '15px', fontWeight: 600, marginBottom: '6px' }}>Embed</div>
          <div style={{ fontSize: '13px', color: '#6b7280', maxWidth: '300px', lineHeight: 1.5 }}>
            {hasSource
              ? 'Shown here as a placeholder. The embed loads in preview and on the published site.'
              : 'Add a URL or paste an embed code in the Properties panel.'}
          </div>
        </div>
      </div>
    );
  }

  const frameStyle = {
    width: '100%',
    height: '100%',
    border: 0,
    display: 'block',
    borderRadius: borderRadius,
  };

  return (
    <div data-id={props['data-id']} data-name={props['data-name']} style={wrapperStyle}>
      {url ? (
        <iframe
          src={url}
          title={title}
          style={frameStyle}
          scrolling={allowScroll ? 'auto' : 'no'}
          allowFullScreen={allowFullscreen}
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          loading="lazy"
        />
      ) : (
        <iframe
          srcDoc={'<!DOCTYPE html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;height:100%;overflow:' + (allowScroll ? 'auto' : 'hidden') + ';}</style></head><body>' + embedCode + '</body></html>'}
          title={title}
          style={frameStyle}
          scrolling={allowScroll ? 'auto' : 'no'}
          allowFullScreen={allowFullscreen}
          loading="lazy"
        />
      )}
    </div>
  );
}

export default withResponsiveProps(Embed);
`;
