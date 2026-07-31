// Beam.tsx — meteor/particle streak that travels across the top of a card.
// Ported 1:1 from revyme-old/builder/src/components/landing/beam/index.tsx
// (Next.js `'use client'` directive dropped — Revyme is Vite/React, no RSC).

import { useEffect, useRef } from 'react';
import styles from './Beam.module.css';

interface BeamProps {
  showBeam?: boolean;
  className?: string;
}

export default function Beam({ showBeam = true, className = '' }: BeamProps) {
  const meteorRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!showBeam) return;
    const meteor = meteorRef.current;
    if (!meteor) return;

    const onEnd = () => {
      meteor.style.visibility = 'hidden';
      const animationDelay = Math.floor(Math.random() * 2);
      const animationDuration = Math.floor(Math.random() * 4);
      const meteorWidth = Math.floor(Math.random() * (150 - 80) + 80);
      meteor.style.setProperty('--meteor-delay', `${animationDelay}s`);
      meteor.style.setProperty('--meteor-duration', `${animationDuration}s`);
      meteor.style.setProperty('--meteor-width', `${meteorWidth}px`);
      // Restart the animation — set animation: none, reflow, then unset.
      meteor.style.animation = 'none';
      void meteor.offsetWidth;
      meteor.style.animation = '';
    };
    const onStart = () => {
      meteor.style.visibility = 'visible';
    };

    meteor.addEventListener('animationend', onEnd);
    meteor.addEventListener('animationstart', onStart);
    return () => {
      meteor.removeEventListener('animationend', onEnd);
      meteor.removeEventListener('animationstart', onStart);
    };
  }, [showBeam]);

  if (!showBeam) return null;
  return (
    <span
      ref={meteorRef}
      className={`absolute z-[40] -top-4 h-[0.1rem] w-[0.1rem] rounded-[9999px] bg-blue-700 shadow-[0_0_0_1px_#ffffff10] rotate-[180deg] ${styles.meteor} ${className}`}
    />
  );
}
