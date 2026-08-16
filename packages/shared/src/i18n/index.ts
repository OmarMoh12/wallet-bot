import { LOCALES, TEXT_DIRECTION_BY_LOCALE, type Locale } from '../domain/enums.js';
import { ar } from './ar.js';
import { en, type MessageKey, type Messages } from './en.js';

export type { MessageKey, Messages };
export { en, ar };
export { LOCALES, TEXT_DIRECTION_BY_LOCALE };
export type { Locale };

const CATALOGUES: Readonly<Record<Locale, Record<string, string>>> = Object.freeze({ en, ar });

export const DEFAULT_LOCALE: Locale = 'en';

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

/**
 * Map a Telegram `language_code` (BCP-47-ish, e.g. "ar-EG", "en-GB") onto a supported locale.
 * Returns null when we have no catalogue for it, so the caller can fall back explicitly.
 */
export function resolveLocaleFromTelegram(languageCode: string | null | undefined): Locale | null {
  if (!languageCode) return null;
  const primary = languageCode.toLowerCase().split(/[-_]/)[0];
  return isLocale(primary) ? primary : null;
}

export function textDirection(locale: Locale): 'ltr' | 'rtl' {
  return TEXT_DIRECTION_BY_LOCALE[locale];
}

export type TranslationParams = Record<string, string | number>;

const pluralRulesCache = new Map<Locale, Intl.PluralRules>();
function pluralRules(locale: Locale): Intl.PluralRules {
  let rules = pluralRulesCache.get(locale);
  if (!rules) {
    rules = new Intl.PluralRules(locale);
    pluralRulesCache.set(locale, rules);
  }
  return rules;
}

const PLACEHOLDER = /\{(\w+)\}/g;

function interpolate(template: string, params?: TranslationParams): string {
  if (!params) return template;
  return template.replace(PLACEHOLDER, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

/**
 * Resolve a message.
 *
 * Lookup order for a plural key (`params.count` present):
 *   `key#<category>` → `key#other` → `key` → English equivalents → the key itself.
 *
 * Returning the raw key on a miss is deliberate: a missing translation shows up loudly in the
 * UI and in tests rather than silently rendering an empty string.
 */
export function translate(
  locale: Locale,
  key: MessageKey | string,
  params?: TranslationParams,
): string {
  const catalogue = CATALOGUES[locale] ?? CATALOGUES[DEFAULT_LOCALE];
  const fallback = CATALOGUES[DEFAULT_LOCALE];

  const candidates: string[] = [];
  if (params && typeof params.count === 'number') {
    const category = pluralRules(locale).select(params.count);
    candidates.push(`${key}#${category}`, `${key}#other`);
  }
  candidates.push(key);

  for (const candidate of candidates) {
    const value = catalogue[candidate];
    if (typeof value === 'string') return interpolate(value, params);
  }
  for (const candidate of candidates) {
    const value = fallback[candidate];
    if (typeof value === 'string') return interpolate(value, params);
  }
  return key;
}

export interface Translator {
  readonly locale: Locale;
  readonly dir: 'ltr' | 'rtl';
  (key: MessageKey | string, params?: TranslationParams): string;
}

export function createTranslator(locale: Locale): Translator {
  const fn = ((key: MessageKey | string, params?: TranslationParams) =>
    translate(locale, key, params)) as Translator;
  return Object.assign(fn, { locale, dir: textDirection(locale) });
}

/** Every key present in the English catalogue. Used by the completeness test. */
export function messageKeys(): MessageKey[] {
  return Object.keys(en) as MessageKey[];
}

/** Keys missing from a locale (ignoring plural variants, which are locale-specific). */
export function missingKeys(locale: Locale): string[] {
  const catalogue = CATALOGUES[locale];
  return messageKeys().filter((key) => {
    if (typeof catalogue[key] === 'string') return false;
    // A plural key is satisfied by any of its category variants.
    if (key.includes('#')) {
      const base = key.split('#')[0];
      return !Object.keys(catalogue).some((candidate) => candidate.startsWith(`${base}#`));
    }
    return true;
  });
}
