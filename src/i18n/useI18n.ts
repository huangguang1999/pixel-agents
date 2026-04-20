import { useCallback, useEffect, useState } from 'react';

import { STRINGS, type Lang, type Strings } from './strings.js';

const STORAGE_KEY = 'pixel-agents:lang';

function detectDefaultLang(): Lang {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'zh' || stored === 'en') return stored;
  } catch {
    // ignore
  }
  const nav = typeof navigator !== 'undefined' ? navigator.language : '';
  return nav.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

const listeners = new Set<(lang: Lang) => void>();
let currentLang: Lang = detectDefaultLang();

export function useI18n(): { lang: Lang; setLang: (l: Lang) => void; t: Strings } {
  const [lang, setLangState] = useState<Lang>(currentLang);

  useEffect(() => {
    const onChange = (l: Lang): void => setLangState(l);
    listeners.add(onChange);
    return () => {
      listeners.delete(onChange);
    };
  }, []);

  const setLang = useCallback((l: Lang) => {
    currentLang = l;
    try {
      localStorage.setItem(STORAGE_KEY, l);
    } catch {
      // ignore
    }
    for (const fn of listeners) fn(l);
  }, []);

  return { lang, setLang, t: STRINGS[lang] };
}
