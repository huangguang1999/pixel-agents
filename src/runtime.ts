/**
 * Runtime detection, provider-agnostic
 *
 * Single source of truth for determining whether the webview is running
 * inside an IDE extension (VS Code, Cursor, Windsurf, etc.) or standalone
 * in a browser.
 */

declare function acquireVsCodeApi(): unknown;

type Runtime = 'vscode' | 'browser';
// Future: 'cursor' | 'windsurf' | 'electron' | etc.

const runtime: Runtime = typeof acquireVsCodeApi !== 'undefined' ? 'vscode' : 'browser';

export const isBrowserRuntime = runtime === 'browser';

/**
 * True when the webview is hosted by the Tauri shell (as opposed to
 * plain `npm run dev` in a normal browser). Tauri 2 injects
 * `__TAURI_INTERNALS__` on the window before any user script runs.
 */
export const isTauriRuntime: boolean =
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
