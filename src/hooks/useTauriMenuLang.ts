import { useEffect } from 'react';

import { useI18n } from '../i18n/useI18n.js';
import { isTauriRuntime } from '../runtime.js';

/**
 * Bridges the native Tauri menu ("Language" submenu) with the JS i18n state.
 *
 * - When the user clicks a language item in the menu, Rust emits a
 *   `lang-change` event; we receive it and call `setLang`.
 * - When the JS-side lang changes (on mount from localStorage, or from any
 *   other UI), we call the Rust command `sync_menu_lang` so the menu's
 *   check mark matches.
 *
 * No-op outside Tauri (plain browser dev).
 */
export function useTauriMenuLang(): void {
  const { lang, setLang } = useI18n();

  useEffect(() => {
    if (!isTauriRuntime) return;
    void (async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('sync_menu_lang', { lang });
      } catch {
        /* non-Tauri runtime */
      }
    })();
  }, [lang]);

  useEffect(() => {
    if (!isTauriRuntime) return;
    let unlisten: (() => void) | undefined;
    void (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        unlisten = await listen<string>('lang-change', (event) => {
          const next = event.payload;
          if (next === 'zh' || next === 'en') setLang(next);
        });
      } catch {
        /* non-Tauri runtime */
      }
    })();
    return () => {
      unlisten?.();
    };
  }, [setLang]);
}
