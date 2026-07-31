// WordRotate — Code component template (slide-up word cycle).
//
// THIRD-PARTY: technique derived from Magic UI
// (https://github.com/magicuidesign/magicui), Copyright (c) Magic UI, MIT.
// Attribution is repeated inside the template literal so it travels into
// projects this component is inserted into. See also the NOTICE file.
//
// Ported from the old builder's `wordRotateJS`. Each word slides out
// upward, the next slides up from below, simple `setInterval` driven
// list cycle.

export const WORD_ROTATE_COMPONENT = `'use client';

// Technique derived from Magic UI (https://github.com/magicuidesign/magicui)
// Copyright (c) Magic UI — MIT License.
// The full MIT permission notice is reproduced in the Revyme NOTICE file.

/** @label "Word Rotate" */
/** @comment "Cycles through a list of words with a slide transition" */
/** @defaultWidth 600 */
/** @defaultHeight 400 */
/** @controls {
  "words": { "type": "text", "label": "Words (comma separated)", "default": "Hello,World,Beautiful,Code" },
  "duration": { "type": "number", "label": "Duration (ms)", "min": 500, "max": 10000, "default": 2500, "step": 100 },
  "color": { "type": "color", "label": "Color", "default": "#111111" },
  "fontSize": { "type": "number", "label": "Font Size", "min": 12, "max": 200, "default": 48, "step": 1 },
  "fontWeight": { "type": "select", "label": "Weight", "default": "700", "options": [{"label":"Regular","value":"400"},{"label":"Medium","value":"500"},{"label":"Semi Bold","value":"600"},{"label":"Bold","value":"700"},{"label":"Black","value":"900"}] },
  "fontFamily": { "type": "text", "label": "Font", "default": "Inter, sans-serif" }
} */

import { useEffect, useState, useMemo } from 'react';
import { withResponsiveProps } from '@revyme/runtime';

function WordRotate({
  words = 'Hello,World,Beautiful,Code', duration = 2500,
  color = '#111111', fontSize = 48, fontWeight = '700', fontFamily = 'Inter, sans-serif',
  ...props
}: {
  words?: string; duration?: number;
  color?: string; fontSize?: number; fontWeight?: string; fontFamily?: string;
  [key: string]: any;
}) {
  const wordList = useMemo(() => {
    const list = words.split(',').map(w => w.trim()).filter(Boolean);
    return list.length >= 1 ? list : ['Text'];
  }, [words]);

  const [index, setIndex] = useState(0);
  const [animating, setAnimating] = useState(false);

  useEffect(() => {
    const interval = setInterval(() => {
      setAnimating(true);
      const t = setTimeout(() => {
        setIndex(i => (i + 1) % wordList.length);
        setAnimating(false);
      }, 250);
      return () => clearTimeout(t);
    }, duration);
    return () => clearInterval(interval);
  }, [duration, wordList.length]);

  const style = {
    color, fontSize: fontSize + 'px', fontWeight, fontFamily,
    display: 'inline-block',
    transition: 'opacity 0.25s ease, transform 0.25s ease',
    opacity: animating ? 0 : 1,
    transform: animating ? 'translateY(-20px)' : 'translateY(0)',
  };

  return (
    <span {...props} style={{ display: 'inline-block', overflow: 'hidden', ...(props.style || {}) }}>
      <span style={style}>{wordList[index]}</span>
    </span>
  );
}

export default withResponsiveProps(WordRotate);
`;
