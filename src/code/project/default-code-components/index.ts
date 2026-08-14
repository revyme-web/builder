// default-code-components/index.ts
// Barrel re-export of all default Code component / code-component templates that ship
// with a fresh project. Each file holds ONE template literal — the actual
// .tsx source string written to ProjectFS at `components/<Name>.tsx`.
//
// Adding a new built-in Code component:
// 1. Drop a new file `MyEmbed.ts` here that exports `MY_EMBED_COMPONENT`.
// 2. Re-export it below.
// 3. Wire the path in `project-fs.ts` (createDefaultProject + BUILT_IN_COMPONENTS).

// ─── Existing Code components ──────────────────────────────────────────────────────
export { ANIMATED_COUNTER_COMPONENT } from './AnimatedCounter';
export { TYPING_EFFECT_COMPONENT } from './TypingEffect';
export { GRADIENT_TEXT_COMPONENT } from './GradientText';
export { IMAGE_SEQUENCE_COMPONENT } from './ImageSequence';
export { MODEL_VIEWER_COMPONENT } from './ModelViewer';
export { SPLINE_SCENE_COMPONENT } from './SplineScene';

// ─── Creative — Text effects (ports of the old builder's customCodeJs) ────
export { MORPHING_TEXT_COMPONENT } from './MorphingText';
export { WORD_ROTATE_COMPONENT } from './WordRotate';
export { SPINNING_TEXT_COMPONENT } from './SpinningText';
export { HANGING_CURVED_COMPONENT } from './HangingCurved';
export { MAGNETIC_TEXT_COMPONENT } from './MagneticText';
export { TEXT_PRESSURE_COMPONENT } from './TextPressure';
export { TYPING_TEXT_COMPONENT } from './TypingText';
export { ROTATING_TEXT_3D_COMPONENT } from './RotatingText3D';
export { VIDEO_TEXT_COMPONENT } from './VideoText';

// ─── Heavy / creative Code components (GPU + Canvas 2D effects) ─────────────────────
export { PARTICLE_FIELD_COMPONENT } from './ParticleField';
export { AURORA_BACKGROUND_COMPONENT } from './AuroraBackground';
export { MATRIX_RAIN_COMPONENT } from './MatrixRain';
export { WAVE_DISTORTION_COMPONENT } from './WaveDistortion';
export { GLITCH_TEXT_COMPONENT } from './GlitchText';

// ─── Noise utility Code components (overlay grain / static / halftone / scanlines) ──
export { FILM_GRAIN_COMPONENT } from './FilmGrain';
export { STATIC_TV_COMPONENT } from './StaticTV';
export { PERLIN_NOISE_COMPONENT } from './PerlinNoise';
export { HALFTONE_COMPONENT } from './Halftone';
export { SCANLINES_COMPONENT } from './Scanlines';
export { CHROMATIC_NOISE_COMPONENT } from './ChromaticNoise';

// ─── Pattern utility Code component (decorative CSS background patterns) ────────────
export { PATTERN_COMPONENT } from './Pattern';

// ─── Backgrounds (canvas-2D animated gradient/wave effects + particles) ────
export { WAVE_LINES_COMPONENT } from './WaveLines';
export { WAVE_GRADIENT_COMPONENT } from './WaveGradient';
export { MESH_GRADIENT_COMPONENT } from './MeshGradient';
export { PLASMA_SHADER_COMPONENT } from './PlasmaShader';
export { LIQUID_METAL_COMPONENT } from './LiquidMetal';
export { CAUSTICS_LIGHT_COMPONENT } from './CausticsLight';
export { NEON_PARTICLE_FIELD_COMPONENT } from './NeonParticleField';

// ─── Containers (slot-based — render connected canvas nodes as children) ──
export { LENS_BOX_COMPONENT } from './LensBox';
export { MAGNET_BOX_COMPONENT } from './MagnetBox';

// ─── Effects (slot-based — animate connected canvas nodes) ────────────────
export { MARQUEE_COMPONENT } from './Marquee';
export { CAROUSEL_COMPONENT } from './Carousel';
export { RIBBON_MARQUEE_COMPONENT } from './RibbonMarquee';
export { MARQUEE_3D_COMPONENT } from './Marquee3D';
export { MOTION_TRAIL_COMPONENT } from './MotionTrail';
export { HORIZONTAL_SCROLL_COMPONENT } from './HorizontalScroll';

// ─── Cursors (region hotspots — no slot, no children; the bounding box
//     IS the cursor zone, see BlobCursor.ts for the shared pattern) ─────────
export { BLOB_CURSOR_COMPONENT } from './BlobCursor';
export { DESIGN_CURSOR_COMPONENT } from './DesignCursor';
export { RIBBON_CURSOR_COMPONENT } from './RibbonCursor';
export { SPLASH_CURSOR_COMPONENT } from './SplashCursor';

// ─── Embed Code components (configurable iframe/widget wrappers) ────────────────────
export { YOUTUBE_EMBED_COMPONENT } from './YouTubeEmbed';
export { VIMEO_EMBED_COMPONENT } from './VimeoEmbed';
export { SOUNDCLOUD_EMBED_COMPONENT } from './SoundCloudEmbed';
export { SPOTIFY_EMBED_COMPONENT } from './SpotifyEmbed';
export { GOOGLE_MAPS_EMBED_COMPONENT } from './GoogleMapsEmbed';
export { FACEBOOK_EMBED_COMPONENT } from './FacebookEmbed';
export { TWITTER_EMBED_COMPONENT } from './TwitterEmbed';
export { INSTAGRAM_EMBED_COMPONENT } from './InstagramEmbed';
export { LINKEDIN_EMBED_COMPONENT } from './LinkedInEmbed';
export { PINTEREST_EMBED_COMPONENT } from './PinterestEmbed';
export { TIKTOK_EMBED_COMPONENT } from './TikTokEmbed';

// ─── Form Code components (configurable iframe embeds with placeholder fallback) ────
export { CALENDLY_EMBED_COMPONENT } from './CalendlyEmbed';
export { TYPEFORM_EMBED_COMPONENT } from './TypeformEmbed';
export { GOOGLE_FORM_EMBED_COMPONENT } from './GoogleFormEmbed';

// ─── Interactive utility Code components (theme + locale, real on the live site) ───
export { THEME_TOGGLE_COMPONENT } from './ThemeToggle';
export { COPY_BUTTON_COMPONENT } from './CopyButton';
export { LOCALE_SWITCHER_COMPONENT } from './LocaleSwitcher';
