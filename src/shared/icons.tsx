import React from 'react';

type IconProps = React.SVGProps<SVGSVGElement>;

export const FrameToolbarIcon: React.FC<IconProps> = (props) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    {...props}
  >
    <g strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6h18m-3-3v18M3 18h18M6 3v18" />
      <path fill="currentColor" opacity="0.16" d="M6 6h12v12H6z" />
    </g>
  </svg>
);

export const TextToolbarIcon: React.FC<IconProps & { size?: number }> = ({
  size,
  width,
  height,
  ...props
}) => {
  const maskId = React.useId();
  return (
    <svg
      viewBox="0 0 48 48"
      width={width ?? size}
      height={height ?? size}
      {...props}
    >
      <mask id={maskId}>
        <g fill="none" strokeLinejoin="round" strokeWidth="4">
          <rect
            width="36"
            height="36"
            x="6"
            y="6"
            fill="#fff"
            stroke="#fff"
            rx="3"
          />
          <path
            stroke="#000"
            strokeLinecap="round"
            d="M16 19v-3h16v3M22 34h4m-2-16v16"
          />
        </g>
      </mask>
      <path fill="currentColor" d="M0 0h48v48H0z" mask={`url(#${maskId})`} />
    </svg>
  );
};

export const SearchIcon: React.FC<IconProps> = (props) => (
  <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
    <path d="M15.762 17.177A8.501 8.501 0 0 1 4.49 4.49a8.5 8.5 0 0 1 12.686 11.272l5.345 5.345l-1.415 1.414z" />
  </svg>
);

export const HandToolbarIcon: React.FC<IconProps> = (props) => (
  <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
    <path d="M14.594 4.44a2.8 2.8 0 0 1 1.063-.19c1.176.023 2.521.832 2.521 2.462v.323c.34-.133.701-.191 1.05-.184c1.177.022 2.522.83 2.522 2.46v4.4c0 3.843-2.761 6.463-5.977 7.509c-3.202 1.041-7.092.609-9.582-1.884l-.002-.002l-3.214-3.24l-.027-.028c-1.038-1.16-.82-2.85.009-3.828c.435-.515 1.078-.885 1.855-.875q.491.006.976.21V6.711c0-.81.332-1.458.864-1.887c.513-.413 1.162-.586 1.773-.574c.375.006.76.083 1.118.236c.053-.693.352-1.259.816-1.65c.495-.42 1.128-.598 1.726-.586c1.109.02 2.368.74 2.509 2.19" />
  </svg>
);

export const CommentBubbleIcon: React.FC<IconProps> = (props) => (
  <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
    <path
      fillRule="evenodd"
      d="M12 2C6.477 2 2 6.477 2 12a10 10 0 0 0 .951 4.262l-.93 4.537a1 1 0 0 0 1.18 1.18l4.537-.93c1.294.61 2.74.95 4.262.95c5.523 0 10-4.476 10-10c0-5.522-4.477-10-10-10"
      clipRule="evenodd"
    />
  </svg>
);

export const PlayIcon: React.FC<IconProps & { size?: number }> = ({
  size,
  width,
  height,
  ...props
}) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="currentColor"
    width={width ?? size}
    height={height ?? size}
    {...props}
  >
    <path d="M21.409 9.353a2.998 2.998 0 0 1 0 5.294L8.597 21.614C6.534 22.737 4 21.277 4 18.968V5.033c0-2.31 2.534-3.769 4.597-2.648z" />
  </svg>
);

export const ReloadIcon: React.FC<IconProps> = (props) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 16 16"
    fill="none"
    style={{ transform: 'scaleX(-1)' }}
    {...props}
  >
    <path
      stroke="currentColor"
      strokeLinecap="round"
      strokeWidth="2"
      d="M13.1 12c-1.2 1.5-3 2.5-5.1 2.5c-3.6 0-6.5-2.9-6.5-6.5S4.4 1.5 8 1.5c2.2 0 4.1 1.1 5.3 2.7m.2-3.2v3c0 .3-.2.5-.5.5h-3"
    />
  </svg>
);

export const ThemeSunIcon: React.FC<IconProps> = (props) => (
  <svg viewBox="0 0 24 24" fill="none" {...props}>
    <path fill="currentColor" d="M18 12a6 6 0 1 1-12 0a6 6 0 0 1 12 0" />
    <path
      fill="currentColor"
      fillRule="evenodd"
      d="M12 1.25a.75.75 0 0 1 .75.75v1a.75.75 0 0 1-1.5 0V2a.75.75 0 0 1 .75-.75M4.399 4.399a.75.75 0 0 1 1.06 0l.393.392a.75.75 0 0 1-1.06 1.061l-.393-.393a.75.75 0 0 1 0-1.06m15.202 0a.75.75 0 0 1 0 1.06l-.393.393a.75.75 0 0 1-1.06-1.06l.393-.393a.75.75 0 0 1 1.06 0M1.25 12a.75.75 0 0 1 .75-.75h1a.75.75 0 0 1 0 1.5H2a.75.75 0 0 1-.75-.75m19 0a.75.75 0 0 1 .75-.75h1a.75.75 0 0 1 0 1.5h-1a.75.75 0 0 1-.75-.75m-2.102 6.148a.75.75 0 0 1 1.06 0l.393.393a.75.75 0 1 1-1.06 1.06l-.393-.393a.75.75 0 0 1 0-1.06m-12.296 0a.75.75 0 0 1 0 1.06l-.393.393a.75.75 0 1 1-1.06-1.06l.392-.393a.75.75 0 0 1 1.061 0M12 20.25a.75.75 0 0 1 .75.75v1a.75.75 0 0 1-1.5 0v-1a.75.75 0 0 1 .75-.75"
      clipRule="evenodd"
    />
  </svg>
);

export const ThemeMoonIcon: React.FC<IconProps> = (props) => (
  <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
    <path d="M12 1.992a10 10 0 1 0 9.236 13.838c.341-.82-.476-1.644-1.298-1.31a6.5 6.5 0 0 1-6.864-10.787l.077-.08c.551-.63.113-1.653-.758-1.653h-.266l-.068-.006z" />
  </svg>
);

export const LayoutRowsIcon: React.FC<IconProps & { size?: number }> = ({
  size,
  width,
  height,
  ...props
}) => (
  <svg
    viewBox="0 0 256 256"
    fill="currentColor"
    width={width ?? size}
    height={height ?? size}
    {...props}
  >
    <path d="M224 152v40a16 16 0 0 1-16 16H48a16 16 0 0 1-16-16v-40a16 16 0 0 1 16-16h160a16 16 0 0 1 16 16M208 48H48a16 16 0 0 0-16 16v40a16 16 0 0 0 16 16h160a16 16 0 0 0 16-16V64a16 16 0 0 0-16-16" />
  </svg>
);

export const LayoutColumnsIcon: React.FC<IconProps & { size?: number }> = ({
  size,
  width,
  height,
  ...props
}) => (
  <svg
    viewBox="0 0 24 24"
    fill="currentColor"
    width={width ?? size}
    height={height ?? size}
    {...props}
  >
    <path d="M15 21q-.825 0-1.412-.587T13 19V5q0-.825.588-1.412T15 3h4q.825 0 1.413.588T21 5v14q0 .825-.587 1.413T19 21zM5 21q-.825 0-1.412-.587T3 19V5q0-.825.588-1.412T5 3h4q.825 0 1.413.588T11 5v14q0 .825-.587 1.413T9 21z" />
  </svg>
);

export const LayoutGridIcon: React.FC<IconProps & { size?: number }> = ({
  size,
  width,
  height,
  ...props
}) => (
  <svg
    viewBox="0 0 24 24"
    fill="currentColor"
    width={width ?? size}
    height={height ?? size}
    {...props}
  >
    <path d="M6.699 2.25c-.84 0-1.546 0-2.106.075c-.594.08-1.137.257-1.574.694s-.614.98-.694 1.574c-.075.56-.075 1.266-.075 2.106V6.8c0 .84 0 1.546.075 2.106c.08.594.257 1.137.694 1.574s.98.614 1.574.694c.56.075 1.266.075 2.106.075H6.8c.84 0 1.546 0 2.106-.075c.594-.08 1.137-.257 1.574-.694s.614-.98.694-1.574c.075-.56.075-1.266.075-2.106v-.1c0-.84 0-1.546-.075-2.106c-.08-.594-.257-1.137-.694-1.574s-.98-.614-1.574-.694c-.56-.075-1.266-.075-2.106-.075zm10.5 0c-.84 0-1.546 0-2.106.075c-.594.08-1.137.257-1.574.694s-.614.98-.694 1.574c-.075.56-.075 1.266-.075 2.106V6.8c0 .84 0 1.546.075 2.106c.08.594.257 1.137.694 1.574s.98.614 1.574.694c.56.075 1.266.075 2.106.075h.102c.84 0 1.546 0 2.106-.075c.594-.08 1.137-.257 1.574-.694s.614-.98.694-1.574c.075-.56.075-1.266.075-2.106v-.1c0-.84 0-1.546-.075-2.106c-.08-.594-.257-1.137-.694-1.574s-.98-.614-1.574-.694c-.56-.075-1.265-.075-2.105-.075zm-10.5 10.507c-.84 0-1.546 0-2.106.075c-.594.08-1.137.257-1.574.694s-.614.98-.694 1.574c-.075.56-.075 1.266-.075 2.106v.102c0 .84 0 1.546.075 2.106c.08.594.257 1.137.694 1.574s.98.614 1.574.694c.56.075 1.266.075 2.106.075H6.8c.84 0 1.546 0 2.106-.075c.594-.08 1.137-.257 1.574-.694s.614-.98.694-1.574c.075-.56.075-1.266.075-2.106v-.102c0-.84 0-1.545-.075-2.106c-.08-.594-.257-1.137-.694-1.574s-.98-.614-1.574-.694c-.56-.075-1.266-.075-2.106-.075zm10.5 0c-.84 0-1.546 0-2.106.075c-.594.08-1.137.257-1.574.694s-.614.98-.694 1.574c-.075.56-.075 1.266-.075 2.106v.102c0 .84 0 1.546.075 2.106c.08.594.257 1.137.694 1.574s.98.614 1.574.694c.56.075 1.266.075 2.106.075h.102c.84 0 1.546 0 2.106-.075c.594-.08 1.137-.257 1.574-.694s.614-.98.694-1.574c.075-.56.075-1.266.075-2.106v-.102c0-.84 0-1.545-.075-2.106c-.08-.594-.257-1.137-.694-1.574s-.98-.614-1.574-.694c-.56-.075-1.266-.075-2.105-.075z" />
  </svg>
);

export const ShapeSquareIcon: React.FC<IconProps & { size?: number }> = ({
  size,
  width,
  height,
  ...props
}) => (
  <svg
    viewBox="0 0 24 24"
    fill="currentColor"
    width={width ?? size}
    height={height ?? size}
    {...props}
  >
    <path d="M19 2H5a3 3 0 0 0-3 3v14a3 3 0 0 0 3 3h14a3 3 0 0 0 3-3V5a3 3 0 0 0-3-3" />
  </svg>
);

export const ShapeCircleIcon: React.FC<IconProps & { size?: number }> = ({
  size,
  width,
  height,
  ...props
}) => (
  <svg
    viewBox="0 0 24 24"
    fill="currentColor"
    width={width ?? size}
    height={height ?? size}
    {...props}
  >
    <path d="M12 22q-2.075 0-3.9-.788t-3.175-2.137T2.788 15.9T2 12t.788-3.9t2.137-3.175T8.1 2.788T12 2t3.9.788t3.175 2.137T21.213 8.1T22 12t-.788 3.9t-2.137 3.175t-3.175 2.138T12 22" />
  </svg>
);

export const ShapeTriangleIcon: React.FC<IconProps & { size?: number }> = ({
  size,
  width,
  height,
  ...props
}) => (
  <svg
    viewBox="0 0 24 24"
    fill="currentColor"
    width={width ?? size}
    height={height ?? size}
    {...props}
  >
    <path d="M10.285 3.858c.777-1.294 2.653-1.294 3.43 0l8.468 14.113c.8 1.333-.16 3.029-1.715 3.029H3.532c-1.554 0-2.514-1.696-1.715-3.029z" />
  </svg>
);

export const ShapePathIcon: React.FC<IconProps & { size?: number }> = ({
  size,
  width,
  height,
  ...props
}) => (
  <svg
    viewBox="0 0 24 24"
    fill="currentColor"
    width={width ?? size}
    height={height ?? size}
    {...props}
  >
    <path d="M18 9.75a3.74 3.74 0 0 1-2.068-.621l-6.803 6.803a3.75 3.75 0 1 1-1.06-1.06l6.802-6.804A3.75 3.75 0 1 1 18 9.75" />
  </svg>
);

export const SketchPencilIcon: React.FC<IconProps & { size?: number }> = ({
  size,
  width,
  height,
  ...props
}) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="currentColor"
    width={width ?? size}
    height={height ?? size}
    {...props}
  >
    <path d="M2.32 4.547c-.388-1.359.868-2.614 2.227-2.226l9.157 2.616c2.996.856 5.144 3.271 5.144 6.485c0 .49-.058.97-.164 1.437c-.042.185.012.326.083.397l2.456 2.456a1.8 1.8 0 0 1 0 2.546l-2.965 2.965a1.8 1.8 0 0 1-2.546 0l-2.46-2.46c-.07-.071-.212-.125-.397-.082a6.4 6.4 0 0 1-1.433.167c-3.214 0-5.63-2.148-6.485-5.144zM7.1 7.099a.75.75 0 0 0 0 1.061l3.005 3.006a.75.75 0 0 0 1.061-1.06L8.16 7.098a.75.75 0 0 0-1.06 0" />
  </svg>
);

export const InsertPlusIcon: React.FC<IconProps> = (props) => (
  <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
    <path d="M18 10h-4V6a2 2 0 0 0-4 0l.071 4H6a2 2 0 0 0 0 4l4.071-.071L10 18a2 2 0 0 0 4 0v-4.071L18 14a2 2 0 0 0 0-4" />
  </svg>
);

export const PagesLayersIcon: React.FC<IconProps & { size?: number }> = ({
  size,
  width,
  height,
  ...props
}) => (
  <svg
    viewBox="0 0 14 14"
    fill="currentColor"
    width={width ?? size}
    height={height ?? size}
    {...props}
  >
    <path
      fillRule="evenodd"
      d="M6.89 1.897a12 12 0 0 0-1.56-.138A2.56 2.56 0 0 1 7.289.254c.49-.07 1.004-.127 1.535-.127s1.046.056 1.535.127c1.187.172 2.082 1.174 2.174 2.35c.074.946.145 1.938.145 2.956s-.071 2.01-.145 2.955c-.092 1.177-.987 2.18-2.174 2.35q-.09.015-.183.026c.057-.777.104-1.603.104-2.451c0-1.071-.075-2.107-.15-3.053c-.135-1.735-1.451-3.231-3.24-3.49M1.467 5.485c-.074.945-.146 1.937-.146 2.955s.072 2.01.146 2.955c.092 1.177.987 2.179 2.173 2.35a11 11 0 0 0 1.535.128a11 11 0 0 0 1.536-.127c1.186-.172 2.081-1.174 2.173-2.35c.074-.946.146-1.938.146-2.956s-.072-2.01-.146-2.955c-.092-1.177-.987-2.18-2.173-2.35a10.6 10.6 0 0 0-1.536-.128c-.53 0-1.045.056-1.535.127c-1.186.172-2.081 1.174-2.173 2.35"
      clipRule="evenodd"
    />
  </svg>
);

export const LibraryStackIcon: React.FC<IconProps & { size?: number }> = ({
  size,
  width,
  height,
  ...props
}) => (
  <svg
    viewBox="0 0 32 32"
    fill="currentColor"
    width={width ?? size}
    height={height ?? size}
    {...props}
  >
    <path d="M3 5.5A2.5 2.5 0 0 1 5.5 3h2A2.5 2.5 0 0 1 10 5.5v21A2.5 2.5 0 0 1 7.5 29h-2A2.5 2.5 0 0 1 3 26.5zm9 0A2.5 2.5 0 0 1 14.5 3h2A2.5 2.5 0 0 1 19 5.5v21a2.5 2.5 0 0 1-2.5 2.5h-2a2.5 2.5 0 0 1-2.5-2.5zm9.8 2.105c-1.295.358-2.064 1.733-1.717 3.07l4.27 16.466c.348 1.338 1.678 2.131 2.973 1.773l1.875-.52c1.294-.357 2.063-1.732 1.716-3.07L26.647 8.86c-.348-1.338-1.678-2.131-2.973-1.773z" />
  </svg>
);

export const GlobeInternationalIcon: React.FC<
  IconProps & { size?: number }
> = ({ size, width, height, ...props }) => (
  <svg
    viewBox="0 0 496 512"
    fill="currentColor"
    width={width ?? size}
    height={height ?? size}
    {...props}
  >
    <path d="M248 8C111.03 8 0 119.03 0 256s111.03 248 248 248s248-111.03 248-248S384.97 8 248 8m82.29 357.6c-3.9 3.88-7.99 7.95-11.31 11.28c-2.99 3-5.1 6.7-6.17 10.71c-1.51 5.66-2.73 11.38-4.77 16.87l-17.39 46.85c-13.76 3-28 4.69-42.65 4.69v-27.38c1.69-12.62-7.64-36.26-22.63-51.25c-6-6-9.37-14.14-9.37-22.63v-32.01c0-11.64-6.27-22.34-16.46-27.97c-14.37-7.95-34.81-19.06-48.81-26.11c-11.48-5.78-22.1-13.14-31.65-21.75l-.8-.72a114.8 114.8 0 0 1-18.06-20.74c-9.38-13.77-24.66-36.42-34.59-51.14c20.47-45.5 57.36-82.04 103.2-101.89l24.01 12.01C203.48 89.74 216 82.01 216 70.11v-11.3c7.99-1.29 16.12-2.11 24.39-2.42l28.3 28.3c6.25 6.25 6.25 16.38 0 22.63L264 112l-10.34 10.34c-3.12 3.12-3.12 8.19 0 11.31l4.69 4.69c3.12 3.12 3.12 8.19 0 11.31l-8 8a8 8 0 0 1-5.66 2.34h-8.99c-2.08 0-4.08.81-5.58 2.27l-9.92 9.65a8.01 8.01 0 0 0-1.58 9.31l15.59 31.19c2.66 5.32-1.21 11.58-7.15 11.58h-5.64c-1.93 0-3.79-.7-5.24-1.96l-9.28-8.06a16.02 16.02 0 0 0-15.55-3.1l-31.17 10.39a11.95 11.95 0 0 0-8.17 11.34c0 4.53 2.56 8.66 6.61 10.69l11.08 5.54c9.41 4.71 19.79 7.16 30.31 7.16s22.59 27.29 32 32h66.75c8.49 0 16.62 3.37 22.63 9.37l13.69 13.69a30.5 30.5 0 0 1 8.93 21.57a46.54 46.54 0 0 1-13.72 32.98M417 274.25c-5.79-1.45-10.84-5-14.15-9.97l-17.98-26.97a23.97 23.97 0 0 1 0-26.62l19.59-29.38c2.32-3.47 5.5-6.29 9.24-8.15l12.98-6.49C440.2 193.59 448 223.87 448 256c0 8.67-.74 17.16-1.82 25.54z" />
  </svg>
);

export const ComponentClusterIcon: React.FC<IconProps & { size?: number }> = ({
  size,
  width,
  height,
  ...props
}) => (
  <svg
    viewBox="0 0 24 24"
    fill="currentColor"
    stroke="currentColor"
    strokeWidth="1.5"
    width={width ?? size}
    height={height ?? size}
    {...props}
  >
    <path d="m5.212 15.111l-2.687-2.687a.6.6 0 0 1 0-.848l2.687-2.687a.6.6 0 0 1 .848 0l2.687 2.687a.6.6 0 0 1 0 .848L6.06 15.111a.6.6 0 0 1-.848 0Zm6.364 6.365l-2.687-2.687a.6.6 0 0 1 0-.849l2.687-2.687a.6.6 0 0 1 .848 0l2.687 2.687a.6.6 0 0 1 0 .848l-2.687 2.688a.6.6 0 0 1-.848 0Zm0-12.729L8.889 6.06a.6.6 0 0 1 0-.849l2.687-2.687a.6.6 0 0 1 .848 0l2.687 2.687a.6.6 0 0 1 0 .849l-2.687 2.687a.6.6 0 0 1-.848 0Zm6.364 6.364l-2.687-2.687a.6.6 0 0 1 0-.848l2.687-2.687a.6.6 0 0 1 .848 0l2.687 2.687a.6.6 0 0 1 0 .848l-2.687 2.687a.6.6 0 0 1-.848 0Z" />
  </svg>
);

// Viewport icons for layers panel
// These icons accept both `size` prop (for lucide-react compatibility) and standard width/height
type ViewportIconProps = IconProps & { size?: number };

export const DesktopViewportIcon: React.FC<ViewportIconProps> = ({
  size,
  width,
  height,
  ...props
}) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="currentColor"
    width={width ?? size}
    height={height ?? size}
    {...props}
  >
    <path d="M5 3.25A2.75 2.75 0 0 0 2.25 6v9A2.75 2.75 0 0 0 5 17.75h6.25v1.5H9a.75.75 0 0 0 0 1.5h6a.75.75 0 0 0 0-1.5h-2.25v-1.5H19A2.75 2.75 0 0 0 21.75 15V6A2.75 2.75 0 0 0 19 3.25z" />
  </svg>
);

export const TabletViewportIcon: React.FC<ViewportIconProps> = ({
  size,
  width,
  height,
  ...props
}) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 1024 1024"
    fill="currentColor"
    width={width ?? size}
    height={height ?? size}
    {...props}
  >
    <path d="M800 64H224c-35.3 0-64 28.7-64 64v768c0 35.3 28.7 64 64 64h576c35.3 0 64-28.7 64-64V128c0-35.3-28.7-64-64-64M512 824c-22.1 0-40-17.9-40-40s17.9-40 40-40s40 17.9 40 40s-17.9 40-40 40" />
  </svg>
);

export const MobileViewportIcon: React.FC<ViewportIconProps> = ({
  size,
  width,
  height,
  ...props
}) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 1024 1024"
    fill="currentColor"
    width={width ?? size}
    height={height ?? size}
    {...props}
  >
    <path d="M744 62H280c-35.3 0-64 28.7-64 64v768c0 35.3 28.7 64 64 64h464c35.3 0 64-28.7 64-64V126c0-35.3-28.7-64-64-64M512 824c-22.1 0-40-17.9-40-40s17.9-40 40-40s40 17.9 40 40s-17.9 40-40 40" />
  </svg>
);

export const ChatImageIcon: React.FC<IconProps> = (props) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width={16}
    height={16}
    viewBox="0 0 16 16"
    {...props}
  >
    <g fill="currentColor">
      <path d="M6.002 5.5a1.5 1.5 0 1 1-3 0a1.5 1.5 0 0 1 3 0"></path>
      <path d="M2.002 1a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V3a2 2 0 0 0-2-2zm12 1a1 1 0 0 1 1 1v6.5l-3.777-1.947a.5.5 0 0 0-.577.093l-3.71 3.71l-2.66-1.772a.5.5 0 0 0-.63.062L1.002 12V3a1 1 0 0 1 1-1z"></path>
    </g>
  </svg>
);

export const SettingsWebsiteIcon: React.FC<IconProps & { size?: number }> = ({
  size,
  width,
  height,
  ...props
}) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width={width ?? size ?? 48}
    height={height ?? size ?? 48}
    viewBox="0 0 48 48"
    fill="currentColor"
    {...props}
  >
    <path d="M8.136 45.956c3.271.266 8.463.544 15.864.544s12.593-.278 15.864-.544c3.288-.267 5.825-2.804 6.092-6.092c.266-3.271.544-8.463.544-15.864c0-3.71-.07-6.864-.173-9.5H1.673A244 244 0 0 0 1.5 24c0 7.401.278 12.593.544 15.864c.267 3.288 2.804 5.825 6.092 6.092" />
    <path
      fillRule="evenodd"
      d="M1.815 11.5q.11-1.933.229-3.364c.267-3.288 2.804-5.825 6.092-6.092C11.407 1.778 16.599 1.5 24 1.5s12.593.278 15.864.544c3.288.267 5.825 2.804 6.092 6.092q.118 1.43.229 3.364zM7.5 7A1.5 1.5 0 0 1 9 5.5h2a1.5 1.5 0 0 1 0 3H9A1.5 1.5 0 0 1 7.5 7M17 5.5a1.5 1.5 0 0 0 0 3h2a1.5 1.5 0 0 0 0-3z"
      clipRule="evenodd"
    />
  </svg>
);

export const SettingsDomainIcon: React.FC<IconProps & { size?: number }> = ({
  size,
  width,
  height,
  ...props
}) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width={width ?? size ?? 14}
    height={height ?? size ?? 14}
    viewBox="0 0 14 14"
    fill="currentColor"
    {...props}
  >
    <path
      fillRule="evenodd"
      d="M5.049.276A7.01 7.01 0 0 0 .028 6.375h3.2a15.8 15.8 0 0 1 1.82-6.1m-1.82 7.35h-3.2a7.01 7.01 0 0 0 5.02 6.1a15.8 15.8 0 0 1-1.82-6.1m3.424 6.367a14.5 14.5 0 0 1-2.17-6.367h5.035a14.5 14.5 0 0 1-2.17 6.367a7 7 0 0 1-.695 0m2.3-.268a7.01 7.01 0 0 0 5.02-6.099h-3.2a15.8 15.8 0 0 1-1.82 6.1m1.82-7.349h3.2a7.01 7.01 0 0 0-5.02-6.1a15.8 15.8 0 0 1 1.82 6.1M6.652.008a7 7 0 0 1 .696 0a14.5 14.5 0 0 1 2.169 6.367H4.483c.217-2.277.963-4.46 2.17-6.367"
      clipRule="evenodd"
    />
  </svg>
);

export const SettingsPlansIcon: React.FC<IconProps & { size?: number }> = ({
  size,
  width,
  height,
  ...props
}) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width={width ?? size ?? 24}
    height={height ?? size ?? 24}
    viewBox="0 0 24 24"
    fill="currentColor"
    {...props}
  >
    <path
      d="M18 10H6c-.84 0-1.55.52-1.85 1.25l11.11 2.72c.31.08.64 0 .88-.2l3.49-2.92c-.37-.51-.96-.85-1.63-.85m0-4H6c-1.1 0-2 .9-2 2v.55C4.59 8.21 5.27 8 6 8h12c.73 0 1.41.21 2 .55V8c0-1.1-.9-2-2-2"
      opacity={0.3}
    />
    <path d="M18 4H6C3.79 4 2 5.79 2 8v8c0 2.21 1.79 4 4 4h12c2.21 0 4-1.79 4-4V8c0-2.21-1.79-4-4-4m-1.86 9.77c-.24.2-.57.28-.88.2L4.15 11.25C4.45 10.52 5.16 10 6 10h12c.67 0 1.26.34 1.63.84zM20 8.55c-.59-.34-1.27-.55-2-.55H6c-.73 0-1.41.21-2 .55V8c0-1.1.9-2 2-2h12c1.1 0 2 .9 2 2z" />
  </svg>
);

export const SettingsAnalyticsIcon: React.FC<IconProps & { size?: number }> = ({
  size,
  width,
  height,
  ...props
}) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width={width ?? size ?? 32}
    height={height ?? size ?? 32}
    viewBox="0 0 32 32"
    fill="currentColor"
    {...props}
  >
    <path d="M29.432 32H2.527A2.533 2.533 0 0 1 0 29.473v-5.895a2.533 2.533 0 0 1 2.527-2.527h7.577V12.63a2.54 2.54 0 0 1 2.527-2.527h8.443V2.567a2.58 2.58 0 0 1 2.567-2.568h5.792a2.583 2.583 0 0 1 2.568 2.568v26.864a2.583 2.583 0 0 1-2.568 2.568z" />
  </svg>
);

// "A/B with strike-through" glyph — Settings → A/B Tests tab.
export const SettingsAbTestsIcon: React.FC<IconProps & { size?: number }> = ({
  size,
  width,
  height,
  ...props
}) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width={width ?? size ?? 24}
    height={height ?? size ?? 24}
    viewBox="0 0 24 24"
    {...props}
  >
    <path d="M0 0h24v24H0z" fill="none" />
    <path
      fill="currentColor"
      d="M4 2a2 2 0 0 0-2 2v8h2V8h2v4h2V4a2 2 0 0 0-2-2zm0 2h2v2H4m18 9.5V14a2 2 0 0 0-2-2h-4v10h4a2 2 0 0 0 2-2v-1.5a1.54 1.54 0 0 0-1.5-1.5a1.54 1.54 0 0 0 1.5-1.5M20 20h-2v-2h2zm0-4h-2v-2h2M5.79 21.61l-1.58-1.22l14-18l1.58 1.22Z"
    />
  </svg>
);

// Beaker / flask icon — Settings → Staging tab.
export const SettingsConnectAiIcon: React.FC<IconProps & { size?: number }> = ({
  size,
  width,
  height,
  ...props
}) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width={width ?? size ?? 24}
    height={height ?? size ?? 24}
    viewBox="0 0 24 24"
    {...props}
  >
    <path d="M0 0h24v24H0z" fill="none" />
    <path
      fill="currentColor"
      d="M12 2l1.9 5.1L19 9l-5.1 1.9L12 16l-1.9-5.1L5 9l5.1-1.9zm7 11l.95 2.55L22.5 16.5l-2.55.95L19 20l-.95-2.55-2.55-.95 2.55-.95zM5 14l.95 2.55L8.5 17.5l-2.55.95L5 21l-.95-2.55L1.5 17.5l2.55-.95z"
    />
  </svg>
);

export const SettingsStagingIcon: React.FC<IconProps & { size?: number }> = ({
  size,
  width,
  height,
  ...props
}) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width={width ?? size ?? 24}
    height={height ?? size ?? 24}
    viewBox="0 0 24 24"
    {...props}
  >
    <path d="M0 0h24v24H0z" fill="none" />
    <path
      fill="currentColor"
      d="M14 4v5.103l3.842 6.51A2 2 0 0 1 16.118 18.5H7.882a2 2 0 0 1-1.724-2.886L10 9.103V4H8V2h8v2zm-2 0v5.5l-3 5h6l-3-5V4z"
    />
  </svg>
);

// Cloud-upload icon — Settings → Backups tab.
export const SettingsBackupsIcon: React.FC<IconProps & { size?: number }> = ({
  size,
  width,
  height,
  ...props
}) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width={width ?? size ?? 24}
    height={height ?? size ?? 24}
    viewBox="0 0 24 24"
    {...props}
  >
    <path d="M0 0h24v24H0z" fill="none" />
    <path
      fill="currentColor"
      d="M12 2c3.728 0 6.82 2.72 7.402 6.283A6.502 6.502 0 0 1 17.5 21h-11A6.5 6.5 0 0 1 4.598 8.283A7.5 7.5 0 0 1 12 2m3 10.914l1.414-1.414L12 7.086L7.586 11.5L9 12.914l2-2V17h2v-6.086z"
    />
  </svg>
);

// Connection handle icons
export const LightningBoltIcon: React.FC<IconProps> = (props) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="currentColor"
    {...props}
  >
    <path d="M13.493 3.659a1.25 1.25 0 0 0-.711-1.296a1.195 1.195 0 0 0-1.46.36L3.518 12.736a1.28 1.28 0 0 0-.16 1.302c.172.393.57.741 1.116.741h6.682l-.65 5.562a1.25 1.25 0 0 0 .711 1.296a1.195 1.195 0 0 0 1.46-.36l7.803-10.013a1.28 1.28 0 0 0 .16-1.302a1.22 1.22 0 0 0-1.116-.741h-6.682z" />
  </svg>
);

export const ChainLinkIcon: React.FC<IconProps & { size?: number }> = ({
  size,
  width,
  height,
  ...props
}) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width={width ?? size ?? 512}
    height={height ?? size ?? 512}
    viewBox="0 0 512 512"
    fill="currentColor"
    {...props}
  >
    <path d="M326.612 185.391c59.747 59.809 58.927 155.698.36 214.59c-.11.12-.24.25-.36.37l-67.2 67.2c-59.27 59.27-155.699 59.262-214.96 0c-59.27-59.26-59.27-155.7 0-214.96l37.106-37.106c9.84-9.84 26.786-3.3 27.294 10.606c.648 17.722 3.826 35.527 9.69 52.721c1.986 5.822.567 12.262-3.783 16.612l-13.087 13.087c-28.026 28.026-28.905 73.66-1.155 101.96c28.024 28.579 74.086 28.749 102.325.51l67.2-67.19c28.191-28.191 28.073-73.757 0-101.83c-3.701-3.694-7.429-6.564-10.341-8.569a16.04 16.04 0 0 1-6.947-12.606c-.396-10.567 3.348-21.456 11.698-29.806l21.054-21.055c5.521-5.521 14.182-6.199 20.584-1.731a152.5 152.5 0 0 1 20.522 17.197M467.547 44.449c-59.261-59.262-155.69-59.27-214.96 0l-67.2 67.2c-.12.12-.25.25-.36.37c-58.566 58.892-59.387 154.781.36 214.59a152.5 152.5 0 0 0 20.521 17.196c6.402 4.468 15.064 3.789 20.584-1.731l21.054-21.055c8.35-8.35 12.094-19.239 11.698-29.806a16.04 16.04 0 0 0-6.947-12.606c-2.912-2.005-6.64-4.875-10.341-8.569c-28.073-28.073-28.191-73.639 0-101.83l67.2-67.19c28.239-28.239 74.3-28.069 102.325.51c27.75 28.3 26.872 73.934-1.155 101.96l-13.087 13.087c-4.35 4.35-5.769 10.79-3.783 16.612c5.864 17.194 9.042 34.999 9.69 52.721c.509 13.906 17.454 20.446 27.294 10.606l37.106-37.106c59.271-59.259 59.271-155.699.001-214.959" />
  </svg>
);

export const PageHomeIcon: React.FC<IconProps & { size?: number }> = ({
  size,
  width,
  height,
  ...props
}) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width={width ?? size ?? 14}
    height={height ?? size ?? 14}
    viewBox="0 0 14 14"
    fill="currentColor"
    {...props}
  >
    <path
      fillRule="evenodd"
      d="M6.093 1.265a1.5 1.5 0 0 1 1.814 0l.66.501a20.5 20.5 0 0 1 4.905 5.335l.212.333a1 1 0 0 1-.844 1.536h-.691c.04.92-.01 1.841-.15 2.752a1.856 1.856 0 0 1-1.836 1.574H8.25V10a1.25 1.25 0 1 0-2.5 0v3.296H3.837a1.86 1.86 0 0 1-1.835-1.574c-.14-.911-.19-1.833-.15-2.752H1.16a1 1 0 0 1-.844-1.536L.527 7.1a20.5 20.5 0 0 1 4.906-5.334z"
      clipRule="evenodd"
    />
  </svg>
);

export const PageDocumentIcon: React.FC<IconProps & { size?: number }> = ({
  size,
  width,
  height,
  ...props
}) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width={width ?? size ?? 16}
    height={height ?? size ?? 16}
    viewBox="0 0 16 16"
    fill="currentColor"
    {...props}
  >
    <path d="M5 1a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2V3a2 2 0 0 0-2-2zm4.59 3.992L9.5 5h-3a.5.5 0 0 1-.09-.992L6.5 4h3a.5.5 0 0 1 .09.992M10 8a.5.5 0 0 1-.41.492L9.5 8.5h-3a.5.5 0 0 1-.09-.992L6.5 7.5h3a.5.5 0 0 1 .5.5m0 3.492a.5.5 0 0 1-.41.492l-.09.008h-3A.5.5 0 0 1 6.41 11l.09-.008h3a.5.5 0 0 1 .5.5" />
  </svg>
);

/**
 * TemplateIcon — a framed box with two horizontal rules, the canonical
 * "template / layout" glyph used by the Library panel's Templates section
 * (TemplatesSection.TemplateLibraryIcon) and FileExplorer's layout rows.
 * Stroke-based; used in the component breadcrumb so a template segment reads
 * as a template, not a component cluster.
 */
export const TemplateIcon: React.FC<IconProps & { size?: number }> = ({
  size,
  width,
  height,
  ...props
}) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width={width ?? size ?? 16}
    height={height ?? size ?? 16}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    {...props}
  >
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <line x1="3" y1="9" x2="21" y2="9" />
    <line x1="3" y1="15" x2="21" y2="15" />
  </svg>
);

/**
 * NotFoundIcon — three-glyph "404" mark, used by FileExplorer's
 * 404 page row. Stroke-based (not fill) so it visually distinguishes
 * itself from the regular page icon and reads as a status marker
 * rather than a document.
 *
 * Glyph: outline of "4 0 4" rendered at 24×24 viewBox; passes
 * stroke=currentColor so it picks up text colour from its container.
 */
export const NotFoundIcon: React.FC<IconProps & { size?: number }> = ({
  size,
  width,
  height,
  ...props
}) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width={width ?? size ?? 16}
    height={height ?? size ?? 16}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    {...props}
  >
    <path d="M3 8v3a1 1 0 0 0 1 1h3m0-4v8m10-8v3a1 1 0 0 0 1 1h3m0-4v8m-11-6v4a2 2 0 1 0 4 0v-4a2 2 0 1 0-4 0" />
  </svg>
);

export const CursorIcon: React.FC<IconProps & { size?: number }> = ({
  size,
  width,
  height,
  ...props
}) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="currentColor"
    width={width ?? size}
    height={height ?? size}
    {...props}
  >
    <path d="M7.407 2.486c-.917-.612-2.251.046-2.152 1.238l.029.347a86 86 0 0 0 2.79 15.693c.337 1.224 2.03 1.33 2.544.195l2.129-4.697c.203-.449.697-.737 1.234-.68l5.266.564c1.209.13 2.063-1.346 1.094-2.281A91 91 0 0 0 7.703 2.684z" />
  </svg>
);

export const PresetSunIcon: React.FC<IconProps> = (props) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <circle cx="12" cy="12" r="5" />
    <line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" />
    <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" /><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
    <line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" />
    <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" /><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
  </svg>
);

/** Moon icon for light/dark preset theme toggle (14x14 stroke style) */
export const PresetMoonIcon: React.FC<IconProps> = (props) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
  </svg>
);

export const CmsIcon: React.FC<IconProps> = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" {...props}>
    <path d="M0 0h24v24H0z" fill="none" />
    <g fill="currentColor" fillRule="evenodd" clipRule="evenodd">
      <path d="M5 15a.75.75 0 0 0-.75.75V18H5c-.75 0-.75.002-.75.002v.035a1.4 1.4 0 0 0 .024.215c.021.128.061.296.136.489c.152.39.441.87.977 1.329c1.066.913 3.023 1.68 6.613 1.68s5.547-.767 6.613-1.68c.536-.46.825-.939.977-1.33a2.5 2.5 0 0 0 .156-.648l.003-.055v-.02l.001-.01v-.005S19.75 18 19 18h.75v-2.25A.75.75 0 0 0 19 15c-.462-.001-.863.285-1.223.573l-.088.067c-.69.493-2.256 1.11-5.689 1.11s-4.999-.617-5.69-1.11a1 1 0 0 1-.073-.071c-.283-.303-.823-.57-1.237-.569" />
      <path d="M5 9a.75.75 0 0 0-.75.75V12H5c-.75 0-.75.002-.75.002v.035a1.4 1.4 0 0 0 .024.215c.021.128.061.296.136.489c.152.39.441.87.977 1.329c1.066.913 3.023 1.68 6.613 1.68s5.547-.767 6.613-1.68c.536-.46.825-.938.977-1.33a2.5 2.5 0 0 0 .156-.648l.003-.055v-.02l.001-.01v-.005S19.75 12 19 12h.75V9.75A.75.75 0 0 0 19 9c-.462-.001-.863.285-1.223.573l-.088.067c-.69.493-2.256 1.11-5.689 1.11s-4.999-.617-5.69-1.11a1 1 0 0 1-.073-.071C5.954 9.266 5.414 8.999 5 9" />
      <path d="M5.387 3.93C6.453 3.018 8.41 2.25 12 2.25s5.547.767 6.613 1.68c.536.46.825.939.977 1.33a2.5 2.5 0 0 1 .156.648a1.2 1.2 0 0 1-.02.344a2.5 2.5 0 0 1-.136.489c-.152.39-.441.87-.977 1.328C17.547 8.983 15.59 9.75 12 9.75s-5.547-.767-6.613-1.68c-.536-.46-.825-.939-.977-1.33a2.5 2.5 0 0 1-.136-.488a1.4 1.4 0 0 1-.024-.256q.002-.125.024-.248c.021-.128.061-.295.136-.489c.152-.39.441-.87.977-1.328" />
    </g>
  </svg>
);

/** Single-cylinder "CMS item" icon — the template ROW inside a collection list
 *  (one record), vs the stacked {@link CmsIcon} for the whole collection. */
export const CmsItemIcon: React.FC<IconProps & { size?: number }> = ({ size = 14, ...props }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <ellipse cx="12" cy="6" rx="7" ry="3" />
    <path d="M5 6v12c0 1.657 3.134 3 7 3s7-1.343 7-3V6" />
  </svg>
);

/** Cursor-anchor align icons — used by the CursorTool's Align row.
 *  A horizontal track with a filled dot positioned at start / center / end.
 *  Matches the Figma "alignment indicator" idiom: the dot is the cursor
 *  anchor, the track is the parent edge it slides along. Stroke uses
 *  currentColor so the active button picks up the segmented-control's
 *  text-primary tint and inactive buttons stay text-secondary. */
export const AlignStartIcon: React.FC<IconProps> = (props) => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" {...props}>
    <line x1="2" y1="7" x2="12" y2="7" />
    <circle cx="3.5" cy="7" r="2" fill="currentColor" stroke="none" />
  </svg>
);

export const AlignCenterIcon: React.FC<IconProps> = (props) => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" {...props}>
    <line x1="2" y1="7" x2="12" y2="7" />
    <circle cx="7" cy="7" r="2" fill="currentColor" stroke="none" />
  </svg>
);

export const AlignEndIcon: React.FC<IconProps> = (props) => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" {...props}>
    <line x1="2" y1="7" x2="12" y2="7" />
    <circle cx="10.5" cy="7" r="2" fill="currentColor" stroke="none" />
  </svg>
);

/** "Add" badge — a big solid grey disc with the `+` KNOCKED OUT in the
 *  variant-card background colour. The `+` uses the original thin-line
 *  glyph. Shared by the canvas "+" buttons: Add Variant, Add
 *  Hover/Pressed, sketch/vector master. */
export const PlusBadgeIcon: React.FC<{ size?: number }> = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" xmlns="http://www.w3.org/2000/svg">
    <circle cx="12" cy="12" r="11" fill="var(--variant-card-badge)" stroke="none" />
    <line x1="12" y1="8" x2="12" y2="16" stroke="#2a2a2a" />
    <line x1="8" y1="12" x2="16" y2="12" stroke="#2a2a2a" />
  </svg>
);
