'use client';

/**
 * A typed, minimal wrapper over `window.Telegram.WebApp`.
 *
 * Written by hand rather than pulled from an SDK. The reasoning: `telegram-web-app.js` has to
 * be loaded from telegram.org either way (it is the platform bridge, not a library we can
 * bundle), so an SDK would add a dependency on top of a global that already exists. What we
 * actually need is ~200 lines: theme events, viewport, haptics, and the back button.
 *
 * Everything here is defensive. Telegram clients differ by version and platform, and half of
 * these methods simply do not exist in older ones — so every call is guarded and every
 * failure is silent. A missing haptic must never break a screen.
 */

export interface TelegramThemeParams {
  bg_color?: string;
  text_color?: string;
  hint_color?: string;
  link_color?: string;
  button_color?: string;
  button_text_color?: string;
  secondary_bg_color?: string;
  header_bg_color?: string;
  accent_text_color?: string;
  section_bg_color?: string;
  section_header_text_color?: string;
  subtitle_text_color?: string;
  destructive_text_color?: string;
}

export interface TelegramWebApp {
  initData: string;
  initDataUnsafe: {
    user?: {
      id: number;
      first_name?: string;
      last_name?: string;
      username?: string;
      language_code?: string;
      photo_url?: string;
    };
    start_param?: string;
  };
  version: string;
  platform: string;
  colorScheme: 'light' | 'dark';
  themeParams: TelegramThemeParams;
  isExpanded: boolean;
  viewportHeight: number;
  viewportStableHeight: number;
  headerColor: string;
  backgroundColor: string;
  ready: () => void;
  expand: () => void;
  close: () => void;
  onEvent: (event: string, handler: () => void) => void;
  offEvent: (event: string, handler: () => void) => void;
  setHeaderColor?: (color: string) => void;
  setBackgroundColor?: (color: string) => void;
  enableClosingConfirmation?: () => void;
  disableVerticalSwipes?: () => void;
  BackButton?: {
    isVisible: boolean;
    show: () => void;
    hide: () => void;
    onClick: (handler: () => void) => void;
    offClick: (handler: () => void) => void;
  };
  MainButton?: {
    text: string;
    isVisible: boolean;
    isActive: boolean;
    show: () => void;
    hide: () => void;
    setText: (text: string) => void;
    onClick: (handler: () => void) => void;
    offClick: (handler: () => void) => void;
    showProgress: (leaveActive?: boolean) => void;
    hideProgress: () => void;
    setParams: (params: {
      text?: string;
      color?: string;
      is_active?: boolean;
      is_visible?: boolean;
    }) => void;
  };
  HapticFeedback?: {
    impactOccurred: (style: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft') => void;
    notificationOccurred: (type: 'error' | 'success' | 'warning') => void;
    selectionChanged: () => void;
  };
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
  }
}

export function getWebApp(): TelegramWebApp | null {
  if (typeof window === 'undefined') return null;
  return window.Telegram?.WebApp ?? null;
}

/** True when running inside a real Telegram client (rather than a plain browser tab). */
export function isTelegramEnvironment(): boolean {
  const webApp = getWebApp();
  return Boolean(webApp?.initData && webApp.initData.length > 0);
}

/**
 * Push Telegram's theme parameters onto the document as CSS custom properties.
 *
 * This is the whole theme engine: the stylesheet already consumes `--tg-theme-*`, so writing
 * the variables here re-colours every surface, including the ones added later.
 */
export function applyThemeParams(params: TelegramThemeParams | undefined): void {
  if (!params || typeof document === 'undefined') return;
  const root = document.documentElement;

  const set = (name: string, value: string | undefined): void => {
    // Only accept colours that look like colours — these values come from the client, and a
    // stray value would end up inside a CSS declaration.
    if (!value || !/^#[0-9a-fA-F]{3,8}$/.test(value)) return;
    root.style.setProperty(name, value);
  };

  set('--tg-theme-bg-color', params.bg_color);
  set('--tg-theme-text-color', params.text_color);
  set('--tg-theme-hint-color', params.hint_color);
  set('--tg-theme-link-color', params.link_color);
  set('--tg-theme-button-color', params.button_color);
  set('--tg-theme-button-text-color', params.button_text_color);
  set('--tg-theme-secondary-bg-color', params.secondary_bg_color);
  set('--tg-theme-header-bg-color', params.header_bg_color ?? params.secondary_bg_color);
  set('--tg-theme-destructive-text-color', params.destructive_text_color);
}

/** Remove any Telegram-provided colours, so the explicit light/dark palette applies. */
export function clearThemeParams(): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  for (const name of [
    '--tg-theme-bg-color',
    '--tg-theme-text-color',
    '--tg-theme-hint-color',
    '--tg-theme-link-color',
    '--tg-theme-button-color',
    '--tg-theme-button-text-color',
    '--tg-theme-secondary-bg-color',
    '--tg-theme-header-bg-color',
    '--tg-theme-destructive-text-color',
  ]) {
    root.style.removeProperty(name);
  }
}

/** Mirror Telegram's viewport height into a CSS variable so layouts can size to it. */
export function applyViewport(webApp: TelegramWebApp | null): void {
  if (!webApp || typeof document === 'undefined') return;
  const height = webApp.viewportStableHeight || webApp.viewportHeight;
  if (height > 0) {
    document.documentElement.style.setProperty('--tg-viewport-stable-height', `${height}px`);
  }
}

/** Initialise the bridge. Safe to call outside Telegram — it simply does nothing. */
export function initTelegram(): TelegramWebApp | null {
  const webApp = getWebApp();
  if (!webApp) return null;

  try {
    webApp.ready();
    webApp.expand();
    // Stops a downward swipe from dismissing the app mid-scroll on iOS.
    webApp.disableVerticalSwipes?.();
    applyViewport(webApp);
  } catch {
    // Older clients throw on the newer methods; the app works without them.
  }

  return webApp;
}

export const haptics = {
  impact(style: 'light' | 'medium' | 'heavy' = 'light'): void {
    try {
      getWebApp()?.HapticFeedback?.impactOccurred(style);
    } catch {
      /* not supported on this client */
    }
  },
  success(): void {
    try {
      getWebApp()?.HapticFeedback?.notificationOccurred('success');
    } catch {
      /* not supported */
    }
  },
  error(): void {
    try {
      getWebApp()?.HapticFeedback?.notificationOccurred('error');
    } catch {
      /* not supported */
    }
  },
  selection(): void {
    try {
      getWebApp()?.HapticFeedback?.selectionChanged();
    } catch {
      /* not supported */
    }
  },
};

/** Copy text, preferring the async clipboard API with a legacy fallback. */
export async function copyText(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      haptics.success();
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }

  try {
    const area = document.createElement('textarea');
    area.value = value;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    if (ok) haptics.success();
    return ok;
  } catch {
    return false;
  }
}
