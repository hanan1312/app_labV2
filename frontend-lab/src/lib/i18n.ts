import { useEffect, useState } from 'react';

type TranslationTree = Record<string, unknown>;
type Translations = Record<string, TranslationTree>; // { EN: {...}, AR: {...} }

// Fetched once and shared by every island on the page — same source of truth
// (/translations.json) the vanilla applyTranslations()/t() use, but looked up directly
// instead of via data-i18n DOM attributes (a React-owned subtree never emits those, so it
// never needs applyTranslations() to touch it).
let translationsPromise: Promise<Translations> | null = null;
function loadTranslations(): Promise<Translations> {
  if (!translationsPromise) {
    translationsPromise = fetch('/static/translations.json').then((r) => r.json());
  }
  return translationsPromise;
}

function readLang(): string {
  return localStorage.getItem('app_lang') || 'EN';
}

function lookup(tree: TranslationTree | undefined, path: string): string | undefined {
  const value = path.split('.').reduce<unknown>((node, key) => {
    if (node && typeof node === 'object') return (node as Record<string, unknown>)[key];
    return undefined;
  }, tree);
  return typeof value === 'string' ? value : undefined;
}

export function useTranslations() {
  const [translations, setTranslations] = useState<Translations | null>(null);
  const [lang, setLang] = useState<string>(readLang);

  useEffect(() => {
    let cancelled = false;
    loadTranslations().then((data) => {
      if (!cancelled) setTranslations(data);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    // #language-selector lives in the still-vanilla page shell and calls the vanilla
    // changeLanguage(), which only updates localStorage + re-runs applyTranslations() over
    // [data-i18n] elements — it has no notion of React islands. Listening for the same
    // change event is how an island picks up a language switch without a page reload.
    const select = document.getElementById('language-selector');
    const onChange = () => setLang(readLang());
    select?.addEventListener('change', onChange);
    return () => select?.removeEventListener('change', onChange);
  }, []);

  function t(path: string, fallback: string, vars?: Record<string, string | number>): string {
    let template = lookup(translations?.[lang], path) ?? fallback;
    if (vars) {
      for (const key of Object.keys(vars)) {
        template = template.split(`{${key}}`).join(String(vars[key]));
      }
    }
    return template;
  }

  return { lang, t };
}
