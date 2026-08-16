import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LOCALE,
  ERROR_CODES,
  LOCALES,
  createTranslator,
  messageKeys,
  missingKeys,
  resolveLocaleFromTelegram,
  textDirection,
  translate,
} from '@wallet/shared';
import { ar } from '../../packages/shared/src/i18n/ar';
import { en } from '../../packages/shared/src/i18n/en';

/**
 * Localisation.
 *
 * The completeness test is the important one: it is what stops a new feature from shipping
 * an English string into an Arabic UI.
 */

describe('catalogue completeness', () => {
  it('has no missing keys in any locale', () => {
    for (const locale of LOCALES) {
      expect(missingKeys(locale), `locale ${locale} is incomplete`).toEqual([]);
    }
  });

  it('translates every error code in every locale', () => {
    // A user-facing error with no translation would render as a raw code.
    for (const locale of LOCALES) {
      for (const code of ERROR_CODES) {
        const message = translate(locale, `error.${code}`);
        expect(message, `${locale}/${code}`).not.toBe(`error.${code}`);
      }
    }
  });

  it('keeps interpolation placeholders consistent between locales', () => {
    const placeholders = (value: string): string[] =>
      [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1] as string).sort();

    for (const key of messageKeys()) {
      // Plural variants are excluded on purpose. A language may lexicalise a form and drop
      // the count legitimately — Arabic's singular is "قبل دقيقة" ("a minute ago"), which
      // needs no {count}, while English's "1 minute ago" does. Requiring them to match
      // would force a worse translation.
      if (key.includes('#')) continue;

      const source = en[key];
      const target = ar[key];
      if (typeof target !== 'string') continue;

      // A placeholder present in one language and absent in another renders as literal
      // "{amount}" text to somebody.
      expect(placeholders(target), `mismatched placeholders in ${key}`).toEqual(
        placeholders(source),
      );
    }
  });

  it('never leaves an unresolved placeholder in a plural variant', () => {
    // The weaker guarantee that still applies to plurals: any placeholder a translation
    // *does* use must be one the English source provides, or it can never be filled.
    const placeholders = (value: string): string[] =>
      [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1] as string);

    for (const [key, value] of Object.entries(ar)) {
      if (!key.includes('#')) continue;
      const base = key.split('#')[0] as string;
      const source = Object.entries(en).find(([candidate]) => candidate.startsWith(`${base}#`));
      const allowed = new Set(source ? placeholders(source[1] as string) : []);
      for (const placeholder of placeholders(value)) {
        expect(allowed.has(placeholder), `${key} uses unknown placeholder {${placeholder}}`).toBe(
          true,
        );
      }
    }
  });
});

describe('translator', () => {
  it('interpolates parameters', () => {
    const t = createTranslator('en');
    expect(t('goals.progress', { percent: 53 })).toBe('53% complete');
  });

  it('selects the right plural form per language', () => {
    const english = createTranslator('en');
    expect(english('common.daysAgo', { count: 1 })).toBe('1 day ago');
    expect(english('common.daysAgo', { count: 5 })).toBe('5 days ago');

    // Arabic has six plural categories; dual and few must not collapse into "other".
    const arabic = createTranslator('ar');
    expect(arabic('common.daysAgo', { count: 1 })).toBe('قبل يوم');
    expect(arabic('common.daysAgo', { count: 2 })).toBe('قبل يومين');
    expect(arabic('common.daysAgo', { count: 3 })).toContain('أيام');
    expect(arabic('common.daysAgo', { count: 11 })).toContain('يوماً');
  });

  it('falls back to the key so a miss is loud rather than blank', () => {
    expect(translate('en', 'does.not.exist')).toBe('does.not.exist');
  });

  it('reports text direction per locale', () => {
    expect(textDirection('en')).toBe('ltr');
    expect(textDirection('ar')).toBe('rtl');
  });
});

describe('locale resolution', () => {
  it('maps Telegram language codes onto supported locales', () => {
    expect(resolveLocaleFromTelegram('ar-EG')).toBe('ar');
    expect(resolveLocaleFromTelegram('en-GB')).toBe('en');
    expect(resolveLocaleFromTelegram('en')).toBe('en');
  });

  it('returns null for unsupported languages rather than guessing', () => {
    expect(resolveLocaleFromTelegram('fr')).toBeNull();
    expect(resolveLocaleFromTelegram(undefined)).toBeNull();
    expect(DEFAULT_LOCALE).toBe('en');
  });
});
