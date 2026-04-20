import type { OfficeState } from '../office/engine/officeState.js';

export interface AgentEvent {
  session_id: string;
  source: string;
  kind:
    | 'session_start'
    | 'pre_tool_use'
    | 'post_tool_use'
    | 'notification'
    | 'stop'
    | 'session_end'
    | 'sub_agent_stop';
  tool?: string | null;
  cwd?: string | null;
  hook_event_name?: string | null;
  ts_ms: number;
  /** Claude Notification hook message — lets us tell permission-required
   *  notifications from idle-waiting-for-input ones. */
  message?: string | null;
  /** PreToolUse(Bash).tool_input.command — used to detect `rm …` patterns
   *  so the agent can take a detour to the trash bin before typing. */
  command?: string | null;
}

/** True when a Bash command-string contains an `rm` invocation (whole-word
 *  match, so `form.ts` and `farm` don't trigger). */
function isRemoveCommand(command: string | null | undefined): boolean {
  if (!command) return false;
  return /(^|[\s;|&(])rm(\s|$)/i.test(command);
}

/** True if a Notification hook's message is a tool-permission request
 *  (as opposed to the idle "waiting for input" reminder). */
function isPermissionNotification(message: string | null | undefined): boolean {
  if (!message) return false;
  return /permission/i.test(message);
}

/** Tools that route the agent to the library bookshelf (side-profile reading pose). */
export const LIBRARY_TOOLS = new Set(['Read', 'Grep', 'WebFetch', 'WebSearch', 'Glob']);

/** Session ↔ agent id map. Injected so tests get fresh state per case. */
export class SessionAgentMap {
  private sessionIdMap = new Map<string, number>();
  private nextAgentId = 1;

  map(sessionId: string): number {
    const existing = this.sessionIdMap.get(sessionId);
    if (existing !== undefined) return existing;
    const id = this.nextAgentId++;
    this.sessionIdMap.set(sessionId, id);
    return id;
  }

  release(sessionId: string): number | null {
    const id = this.sessionIdMap.get(sessionId);
    if (id === undefined) return null;
    this.sessionIdMap.delete(sessionId);
    return id;
  }

  reset(): void {
    this.sessionIdMap.clear();
    this.nextAgentId = 1;
  }
}

export function dispatchAgentEvent(
  os: OfficeState,
  ev: AgentEvent,
  sessions: SessionAgentMap,
): void {
  const sid = ev.session_id;
  switch (ev.kind) {
    case 'session_start': {
      const id = sessions.map(sid);
      if (!os.characters.has(id)) {
        os.addAgent(id);
      }
      os.setAgentSource(id, ev.source);
      os.setAgentIdentity(id, ev.cwd, sid);
      os.markSessionStart(id);
      os.logAgentEvent(id, 'session_start');
      break;
    }
    case 'pre_tool_use': {
      const id = sessions.map(sid);
      if (!os.characters.has(id)) os.addAgent(id);
      os.setAgentSource(id, ev.source);
      // Defensive: if session_start was dropped (e.g. app started mid-session),
      // the first pre_tool_use still carries cwd — recover identity from it.
      os.setAgentIdentity(id, ev.cwd, sid);
      os.cancelVisit(id);
      os.markActivity(id);
      os.setAgentActive(id, true);
      os.clearBubble(id);
      if (ev.tool) {
        os.setAgentTool(id, ev.tool);
        if (LIBRARY_TOOLS.has(ev.tool)) {
          os.sendToLibrary(id);
        } else if (ev.tool === 'Bash' && isRemoveCommand(ev.command)) {
          // Detour to the bin first; visitReturnSec brings them back to the seat.
          if (!os.sendToBin(id)) os.sendToSeat(id);
        } else {
          os.sendToSeat(id);
        }
      }
      os.logAgentEvent(id, 'pre_tool_use', ev.tool, ev.command ?? null);
      break;
    }
    case 'post_tool_use': {
      const id = sessions.map(sid);
      // Don't clear currentTool here — agent may still be walking to library;
      // clearing mid-walk aborts the reading animation. Cleared on next
      // pre_tool_use (overwritten) or on stop.
      os.clearBubble(id);
      os.logAgentEvent(id, 'post_tool_use', ev.tool);
      break;
    }
    case 'notification': {
      const id = sessions.map(sid);
      if (!os.characters.has(id)) os.addAgent(id);
      os.setAgentSource(id, ev.source);
      // Claude fires Notification both for "needs permission" and for
      // "idle — waiting for your input". Only the former is a permission
      // bubble; the idle case is just a waiting reminder.
      const perm = isPermissionNotification(ev.message);
      if (perm) {
        os.showPermissionBubble(id);
      } else {
        os.showWaitingBubble(id);
      }
      os.logAgentEvent(id, 'notification', null, perm ? 'permission' : 'waiting');
      break;
    }
    case 'stop': {
      const id = sessions.map(sid);
      os.cancelVisit(id);
      os.setAgentActive(id, false);
      os.setAgentTool(id, null);
      os.showWaitingBubble(id);
      os.markStop(id);
      os.logAgentEvent(id, 'stop');
      break;
    }
    case 'sub_agent_stop': {
      break;
    }
    case 'session_end': {
      const id = sessions.release(sid);
      if (id !== null) {
        os.logAgentEvent(id, 'session_end');
        os.removeAgent(id);
      }
      break;
    }
  }
}
