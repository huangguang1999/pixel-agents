import { useEffect } from 'react';

import type { OfficeState } from '../office/engine/officeState.js';
import {
  dispatchAgentEvent,
  SessionAgentMap,
  type AgentEvent,
} from './agentEventDispatch.js';

const sessions = new SessionAgentMap();

export function useTauriAgentEvents(getOfficeState: () => OfficeState): void {
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;

    (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        const handler = await listen<AgentEvent>('agent-event', (e) => {
          try {
            dispatchAgentEvent(getOfficeState(), e.payload, sessions);
          } catch (err) {
            console.error('[agent-event] dispatch error', err, e.payload);
          }
        });
        if (cancelled) {
          handler();
        } else {
          unlisten = handler;
        }
      } catch (err) {
        // Not running inside Tauri — silently skip
        console.debug('[agent-event] listener unavailable:', err);
      }
    })();

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [getOfficeState]);
}
