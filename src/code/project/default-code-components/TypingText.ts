// TypingText — Code component template (multi-word type+delete cycle).
// Ported from `typingTextJS`. Different from the existing TypingEffect
// code component, which is a single-string typewriter that loops via clear+
// re-type. This one cycles a comma-separated word list with classic
// "type forward → pause → delete → next word" rhythm and a separate
// delete speed so the deletion can be snappier than the typing.

export const TYPING_TEXT_COMPONENT = `'use client';

/** @label "Typing Text" */
/** @comment "Types out words one at a time with a blinking cursor, then deletes and moves on" */
/** @defaultWidth 600 */
/** @defaultHeight 400 */
/** @controls {
  "words": { "type": "text", "label": "Words (comma separated)", "default": "Hello,World,Beautiful,Code" },
  "typeSpeed": { "type": "number", "label": "Type Speed (ms)", "min": 10, "max": 500, "default": 100, "step": 10 },
  "deleteSpeed": { "type": "number", "label": "Delete Speed (ms)", "min": 10, "max": 300, "default": 50, "step": 10 },
  "pauseDelay": { "type": "number", "label": "Pause (ms)", "min": 100, "max": 5000, "default": 1000, "step": 100 },
  "loop": { "type": "toggle", "label": "Loop", "default": true },
  "showCursor": { "type": "toggle", "label": "Show Cursor", "default": true },
  "color": { "type": "color", "label": "Color", "default": "#111111" },
  "fontSize": { "type": "number", "label": "Font Size", "min": 12, "max": 200, "default": 48, "step": 1 },
  "fontWeight": { "type": "select", "label": "Weight", "default": "700", "options": [{"label":"Regular","value":"400"},{"label":"Medium","value":"500"},{"label":"Semi Bold","value":"600"},{"label":"Bold","value":"700"},{"label":"Black","value":"900"}] },
  "fontFamily": { "type": "text", "label": "Font", "default": "Inter, sans-serif" }
} */

import { useEffect, useState, useMemo } from 'react';
import { withResponsiveProps } from '@revyme/runtime';

function TypingText({
  words = 'Hello,World,Beautiful,Code',
  typeSpeed = 100, deleteSpeed = 50, pauseDelay = 1000,
  loop = true, showCursor = true,
  color = '#111111', fontSize = 48, fontWeight = '700', fontFamily = 'Inter, sans-serif',
  ...props
}: {
  words?: string;
  typeSpeed?: number; deleteSpeed?: number; pauseDelay?: number;
  loop?: boolean; showCursor?: boolean;
  color?: string; fontSize?: number; fontWeight?: string; fontFamily?: string;
  [key: string]: any;
}) {
  const wordList = useMemo(() => {
    const list = words.split(',').map(w => w.trim()).filter(Boolean);
    return list.length >= 1 ? list : ['Text'];
  }, [words]);

  const [text, setText] = useState('');
  const [wordIndex, setWordIndex] = useState(0);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isPaused, setIsPaused] = useState(false);

  useEffect(() => {
    const currentWord = wordList[wordIndex];

    if (isPaused) {
      const t = setTimeout(() => { setIsPaused(false); setIsDeleting(true); }, pauseDelay);
      return () => clearTimeout(t);
    }

    if (isDeleting) {
      if (text.length > 0) {
        const t = setTimeout(() => setText(text.slice(0, -1)), deleteSpeed);
        return () => clearTimeout(t);
      } else {
        setIsDeleting(false);
        const nextIdx = wordIndex + 1;
        if (!loop && nextIdx >= wordList.length) return;
        setWordIndex(nextIdx % wordList.length);
      }
    } else {
      if (text.length < currentWord.length) {
        const t = setTimeout(() => setText(currentWord.slice(0, text.length + 1)), typeSpeed);
        return () => clearTimeout(t);
      } else {
        setIsPaused(true);
      }
    }
  }, [text, wordIndex, isDeleting, isPaused, wordList, typeSpeed, deleteSpeed, pauseDelay, loop]);

  const baseStyle = { color, fontSize: fontSize + 'px', fontWeight, fontFamily };

  return (
    <span {...props} style={{ display: 'inline-block', ...(props.style || {}) }}>
      <span style={baseStyle}>
        {text}
        {showCursor && (
          <span
            style={{
              display: 'inline-block', width: 2, height: '1em', marginLeft: 2,
              verticalAlign: 'middle', backgroundColor: color,
              animation: 'typing-text-blink 1s infinite',
            }}
          />
        )}
      </span>
      <style>{'@keyframes typing-text-blink { 0%, 50% { opacity: 1; } 51%, 100% { opacity: 0; } }'}</style>
    </span>
  );
}

export default withResponsiveProps(TypingText);
`;
