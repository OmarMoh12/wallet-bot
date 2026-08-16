'use client';

import type { SVGProps } from 'react';

/**
 * Inline icon set.
 *
 * Hand-drawn rather than an icon package: this app needs about twenty glyphs, and a package
 * would ship hundreds while adding a dependency to the critical path of a mobile WebView.
 * Every icon uses `currentColor`, so they inherit the Telegram theme automatically.
 *
 * Icons are decorative by default (`aria-hidden`). When an icon is the only content of a
 * control, the control carries the `aria-label`.
 */

export type IconName =
  | 'home'
  | 'wallet'
  | 'activity'
  | 'calendar'
  | 'settings'
  | 'arrow-up'
  | 'arrow-down'
  | 'arrow-left'
  | 'arrow-right'
  | 'plus'
  | 'check'
  | 'close'
  | 'copy'
  | 'qr'
  | 'eye'
  | 'eye-off'
  | 'chevron'
  | 'search'
  | 'filter'
  | 'external'
  | 'warning'
  | 'info'
  | 'clock'
  | 'target'
  | 'chart'
  | 'trash'
  | 'edit'
  | 'refresh'
  | 'lock'
  | 'globe'
  | 'sun'
  | 'moon'
  | 'bell'
  | 'tag';

const PATHS: Record<IconName, string> = {
  home: 'M3 10.5 12 3l9 7.5M5.5 9.5V20a1 1 0 0 0 1 1H10v-5h4v5h3.5a1 1 0 0 0 1-1V9.5',
  wallet:
    'M3 8.5A2.5 2.5 0 0 1 5.5 6H18a2 2 0 0 1 2 2v1M3 8.5V17a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-2M21 9h-4a2.5 2.5 0 0 0 0 5h4V9Z',
  activity: 'M4 6h16M4 12h16M4 18h10',
  calendar:
    'M7 3v3m10-3v3M4 9h16M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z',
  settings:
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm8-3a8 8 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a8 8 0 0 0-2-1.2l-.4-2.6h-4l-.4 2.6a8 8 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a8 8 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a8 8 0 0 0 2 1.2l.4 2.6h4l.4-2.6a8 8 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.07-.4.1-.8.1-1.2Z',
  'arrow-up': 'M12 20V4m0 0-6 6m6-6 6 6',
  'arrow-down': 'M12 4v16m0 0 6-6m-6 6-6-6',
  'arrow-left': 'M20 12H4m0 0 6-6m-6 6 6 6',
  'arrow-right': 'M4 12h16m0 0-6-6m6 6-6 6',
  plus: 'M12 5v14M5 12h14',
  check: 'M4 12.5 9.5 18 20 6.5',
  close: 'M6 6l12 12M18 6 6 18',
  copy: 'M9 9V5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-4M5 9h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1Z',
  qr: 'M4 4h6v6H4V4Zm10 0h6v6h-6V4ZM4 14h6v6H4v-6Zm10 3h3m3 0v3m-6 0h3m0-6h3',
  eye: 'M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12Zm10 2.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z',
  'eye-off':
    'M3 3l18 18M10.6 6.1A9.9 9.9 0 0 1 12 6c6.4 0 10 6 10 6a17 17 0 0 1-3.3 4M6.6 7.6C3.9 9.3 2 12 2 12s3.6 6 10 6a10 10 0 0 0 3.6-.7M9.9 9.9a3 3 0 0 0 4.2 4.2',
  chevron: 'M9 5l7 7-7 7',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm10 2-4.5-4.5',
  filter: 'M3 5h18l-7 8v6l-4 2v-8L3 5Z',
  external: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  warning: 'M12 3 1.5 21h21L12 3Zm0 6v6m0 3.5v.5',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-13v.5m0 3V16',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-14v5l3.5 2',
  target:
    'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-4.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9Zm0-3a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z',
  chart: 'M4 20V10m5 10V4m5 16v-7m5 7V8',
  trash: 'M4 7h16M10 7V4h4v3m-7 0 1 13h8l1-13',
  edit: 'M4 20h4l10-10-4-4L4 16v4Zm10-14 4 4',
  refresh: 'M3 12a9 9 0 0 1 15.5-6.2M21 12a9 9 0 0 1-15.5 6.2M18 3v4h-4M6 21v-4h4',
  lock: 'M7 11V8a5 5 0 0 1 10 0v3M5 11h14a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1Z',
  globe:
    'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-18c-2.5 2.5-3.5 6-3.5 9s1 6.5 3.5 9c2.5-2.5 3.5-6 3.5-9s-1-6.5-3.5-9ZM3.5 9h17M3.5 15h17',
  sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10Zm0-14v2m0 14v2M3 12h2m14 0h2M5.6 5.6l1.4 1.4m10 10 1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4',
  moon: 'M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z',
  bell: 'M6 9a6 6 0 1 1 12 0c0 4 1.5 5.5 2 6H4c.5-.5 2-2 2-6Zm4 9a2 2 0 0 0 4 0',
  tag: 'M4 4h7l9 9-7 7-9-9V4Zm3.5 3.5h.01',
};

const FILLED = new Set<IconName>([]);

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: IconName;
  size?: number;
  /** Provide when the icon carries meaning that no adjacent text conveys. */
  label?: string;
}

export function Icon({ name, size = 20, label, className, ...rest }: IconProps) {
  const path = PATHS[name];
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={FILLED.has(name) ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden={label ? undefined : true}
      role={label ? 'img' : undefined}
      focusable="false"
      {...rest}
    >
      {label ? <title>{label}</title> : null}
      <path d={path} />
    </svg>
  );
}

/**
 * Asset glyph.
 *
 * A coloured monogram rather than a logo: shipping third-party token artwork would mean
 * remote images (blocked by our CSP) or bundling trademarks. The colour is derived from the
 * symbol, so the same asset always looks the same.
 */
export function AssetGlyph({ symbol, size = 40 }: { symbol: string; size?: number }) {
  const palette: Record<string, string> = {
    USDT: '#26A17B',
    USDC: '#2775CA',
    TON: '#0098EA',
    TRX: '#E8443A',
  };
  const upper = symbol.toUpperCase();
  const color = palette[upper] ?? '#5B7A99';

  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-full font-semibold"
      style={{
        width: size,
        height: size,
        background: `color-mix(in srgb, ${color} 22%, transparent)`,
        color,
        fontSize: size * 0.34,
        letterSpacing: '-0.02em',
      }}
      aria-hidden="true"
    >
      {upper.slice(0, 4)}
    </span>
  );
}
