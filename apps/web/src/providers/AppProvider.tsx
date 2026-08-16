'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  DEFAULT_LOCALE,
  createTranslator,
  isLocale,
  textDirection,
  type Locale,
  type SessionDto,
  type ThemePreference,
  type TranslationParams,
  type UserSettingsDto,
} from '@wallet/shared';
import { ApiError, api, setReauthenticator, setSessionToken } from '@/lib/api';
import {
  applyThemeParams,
  applyViewport,
  clearThemeParams,
  getWebApp,
  initTelegram,
  isTelegramEnvironment,
  type TelegramWebApp,
} from '@/lib/telegram';

/**
 * Application shell state: session, theme, language.
 *
 * Theme resolution, in order:
 *   1. user preference `dark` / `light`  → `data-theme` on <html>, Telegram colours cleared;
 *   2. user preference `system`          → follow Telegram's live theme parameters.
 *
 * Case 2 is the default and is fully reactive: Telegram emits `themeChanged` when the user
 * switches theme with the Mini App open, and we re-apply the variables immediately.
 */

export type AuthState = 'loading' | 'authenticated' | 'unauthenticated' | 'error';

interface AppState {
  authState: AuthState;
  session: SessionDto | null;
  settings: UserSettingsDto | null;
  locale: Locale;
  dir: 'ltr' | 'rtl';
  theme: ThemePreference;
  resolvedTheme: 'dark' | 'light';
  error: string | null;
  isTelegram: boolean;
  startParam: string | null;
  t: (key: string, params?: TranslationParams) => string;
  refreshSettings: () => Promise<void>;
  applySettings: (settings: UserSettingsDto) => void;
  retry: () => void;
  toast: (message: string, tone?: 'info' | 'success' | 'error') => void;
  toasts: Toast[];
  dismissToast: (id: number) => void;
}

export interface Toast {
  id: number;
  message: string;
  tone: 'info' | 'success' | 'error';
}

const AppContext = createContext<AppState | null>(null);

export function useApp(): AppState {
  const value = useContext(AppContext);
  if (!value) throw new Error('useApp must be used inside <AppProvider>');
  return value;
}

/** Convenience hook for the common case. */
export function useT(): (key: string, params?: TranslationParams) => string {
  return useApp().t;
}

export function AppProvider({ children }: { children: ReactNode }): ReactNode {
  const [authState, setAuthState] = useState<AuthState>('loading');
  const [session, setSession] = useState<SessionDto | null>(null);
  const [settings, setSettings] = useState<UserSettingsDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [telegramScheme, setTelegramScheme] = useState<'dark' | 'light'>('dark');
  const [attempt, setAttempt] = useState(0);

  const webAppRef = useRef<TelegramWebApp | null>(null);
  const toastId = useRef(0);

  const locale: Locale = isLocale(settings?.locale) ? settings.locale : DEFAULT_LOCALE;
  const theme: ThemePreference = settings?.themePreference ?? 'system';
  const dir = textDirection(locale);

  const translator = useMemo(() => createTranslator(locale), [locale]);
  const t = useCallback(
    (key: string, params?: TranslationParams) => translator(key, params),
    [translator],
  );

  /* --------------------------------------------------------------- toasts -- */

  const dismissToast = useCallback((id: number) => {
    setToasts((current) => current.filter((entry) => entry.id !== id));
  }, []);

  const toast = useCallback(
    (message: string, tone: 'info' | 'success' | 'error' = 'info') => {
      toastId.current += 1;
      const id = toastId.current;
      setToasts((current) => [...current.slice(-2), { id, message, tone }]);
      setTimeout(() => dismissToast(id), 3600);
    },
    [dismissToast],
  );

  /* ------------------------------------------------------- authentication -- */

  const authenticate = useCallback(async (): Promise<string | null> => {
    const webApp = webAppRef.current ?? getWebApp();
    const initData = webApp?.initData ?? '';

    if (!initData) {
      // Opened outside Telegram. Not an error state we can recover from, so say so plainly
      // rather than showing a broken dashboard.
      setAuthState('unauthenticated');
      return null;
    }

    try {
      const result = await api.post<SessionDto>('/api/auth/telegram', { initData });
      setSessionToken(result.token);
      setSession(result);
      setSettings(result.settings);
      setAuthState('authenticated');
      setError(null);
      return result.token;
    } catch (caught) {
      setSessionToken(null);
      const code = caught instanceof ApiError ? caught.code : 'INTERNAL_ERROR';
      setError(String(code));
      setAuthState('error');
      return null;
    }
  }, []);

  // Register the re-authenticator so a mid-session 401 recovers silently.
  useEffect(() => {
    setReauthenticator(authenticate);
    return () => setReauthenticator(null);
  }, [authenticate]);

  useEffect(() => {
    const webApp = initTelegram();
    webAppRef.current = webApp;
    if (webApp) setTelegramScheme(webApp.colorScheme === 'light' ? 'light' : 'dark');
    void authenticate();
  }, [authenticate, attempt]);

  /* ---------------------------------------------------- telegram theme sync -- */

  useEffect(() => {
    const webApp = webAppRef.current;
    if (!webApp) return;

    const onThemeChanged = (): void => {
      const current = getWebApp();
      if (!current) return;
      setTelegramScheme(current.colorScheme === 'light' ? 'light' : 'dark');
      // Only adopt Telegram's colours when the user has not overridden the theme.
      if ((settings?.themePreference ?? 'system') === 'system') {
        applyThemeParams(current.themeParams);
      }
    };

    const onViewportChanged = (): void => applyViewport(getWebApp());

    webApp.onEvent('themeChanged', onThemeChanged);
    webApp.onEvent('viewportChanged', onViewportChanged);
    return () => {
      webApp.offEvent('themeChanged', onThemeChanged);
      webApp.offEvent('viewportChanged', onViewportChanged);
    };
  }, [settings?.themePreference]);

  /* Apply the resolved theme to <html>. */
  const resolvedTheme: 'dark' | 'light' =
    theme === 'system' ? telegramScheme : theme === 'light' ? 'light' : 'dark';

  useEffect(() => {
    const root = document.documentElement;

    if (theme === 'system') {
      // Follow Telegram: remove our override and adopt its palette.
      root.removeAttribute('data-theme');
      const webApp = getWebApp();
      if (webApp) applyThemeParams(webApp.themeParams);
      else root.setAttribute('data-theme', telegramScheme);
    } else {
      // Explicit choice wins over whatever Telegram reports.
      clearThemeParams();
      root.setAttribute('data-theme', theme);
    }

    // Keep the Telegram header in step with the app background.
    const webApp = getWebApp();
    try {
      webApp?.setHeaderColor?.(resolvedTheme === 'light' ? '#ffffff' : '#17212b');
      webApp?.setBackgroundColor?.(resolvedTheme === 'light' ? '#ffffff' : '#0e1621');
    } catch {
      /* older clients */
    }
  }, [theme, telegramScheme, resolvedTheme]);

  /* Language + direction on <html>, so RTL is a document-level concern. */
  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = dir;
  }, [locale, dir]);

  /* ------------------------------------------------------------- settings -- */

  const refreshSettings = useCallback(async () => {
    try {
      const next = await api.get<UserSettingsDto>('/api/settings');
      setSettings(next);
    } catch {
      // Keep the current settings; a transient failure should not reset the user's UI.
    }
  }, []);

  const applySettings = useCallback((next: UserSettingsDto) => {
    setSettings(next);
  }, []);

  const retry = useCallback(() => {
    setAuthState('loading');
    setError(null);
    setAttempt((value) => value + 1);
  }, []);

  const value = useMemo<AppState>(
    () => ({
      authState,
      session,
      settings,
      locale,
      dir,
      theme,
      resolvedTheme,
      error,
      isTelegram: isTelegramEnvironment(),
      startParam: webAppRef.current?.initDataUnsafe?.start_param ?? null,
      t,
      refreshSettings,
      applySettings,
      retry,
      toast,
      toasts,
      dismissToast,
    }),
    [
      authState,
      session,
      settings,
      locale,
      dir,
      theme,
      resolvedTheme,
      error,
      t,
      refreshSettings,
      applySettings,
      retry,
      toast,
      toasts,
      dismissToast,
    ],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
