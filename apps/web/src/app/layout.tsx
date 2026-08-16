import type { Metadata, Viewport } from 'next';
import Script from 'next/script';
import { AppProvider } from '@/providers/AppProvider';
import { AppShell } from '@/components/layout/AppShell';
import './globals.css';

export const metadata: Metadata = {
  title: 'Wallet',
  description: 'Private financial dashboard',
  applicationName: 'Wallet',
  // A Mini App is private by definition; keep it out of search results.
  robots: { index: false, follow: false },
  formatDetection: { telephone: false, date: false, address: false, email: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  // Prevents the iOS zoom-on-focus jump that makes a WebView feel like a web page.
  userScalable: false,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: '#0e1621' },
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // `dir` and `lang` are corrected on the client once the user's locale is known; starting
    // at ltr/en avoids a flash of mirrored layout for the (majority) English case.
    <html lang="en" dir="ltr" suppressHydrationWarning>
      <head>
        {/*
          The Telegram bridge must come from telegram.org — it is the platform API, not a
          library we can bundle. `beforeInteractive` guarantees `window.Telegram.WebApp`
          exists before any client component runs.
        */}
        <Script src="https://telegram.org/js/telegram-web-app.js" strategy="beforeInteractive" />
      </head>
      <body className="antialiased">
        <AppProvider>
          <AppShell>{children}</AppShell>
        </AppProvider>
      </body>
    </html>
  );
}
