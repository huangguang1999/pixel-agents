import { describe, expect, it, beforeEach } from 'vitest';

import type { OfficeState } from '../office/engine/officeState.js';
import {
  AgentEvent,
  LIBRARY_TOOLS,
  SessionAgentMap,
  dispatchAgentEvent,
} from '../hooks/agentEventDispatch.js';

type Call = [string, ...unknown[]];

interface MockOffice {
  calls: Call[];
  characters: Map<number, object>;
  addAgent: (id: number) => void;
  setAgentActive: (id: number, active: boolean) => void;
  setAgentTool: (id: number, tool: string | null) => void;
  setAgentSource: (id: number, source: string | null | undefined) => void;
  setAgentIdentity: (
    id: number,
    cwd: string | null | undefined,
    sessionId: string | null | undefined,
  ) => void;
  clearBubble: (id: number) => void;
  sendToLibrary: (id: number) => boolean;
  sendToSeat: (id: number) => void;
  sendToBin: (id: number) => boolean;
  showPermissionBubble: (id: number) => void;
  showWaitingBubble: (id: number) => void;
  removeAgent: (id: number) => void;
  markSessionStart: (id: number) => void;
  markActivity: (id: number) => void;
  markStop: (id: number) => void;
  cancelVisit: (id: number) => void;
  logAgentEvent: (id: number, kind: string, tool?: string | null, detail?: string | null) => void;
}

function createMockOffice(): MockOffice {
  const calls: Call[] = [];
  const characters = new Map<number, object>();
  const mock: MockOffice = {
    calls,
    characters,
    addAgent(id) {
      calls.push(['addAgent', id]);
      characters.set(id, {});
    },
    setAgentActive(id, active) {
      calls.push(['setAgentActive', id, active]);
    },
    setAgentTool(id, tool) {
      calls.push(['setAgentTool', id, tool]);
    },
    setAgentSource(id, source) {
      calls.push(['setAgentSource', id, source ?? null]);
    },
    setAgentIdentity(id, cwd, sessionId) {
      calls.push(['setAgentIdentity', id, cwd ?? null, sessionId ?? null]);
    },
    clearBubble(id) {
      calls.push(['clearBubble', id]);
    },
    sendToLibrary(id) {
      calls.push(['sendToLibrary', id]);
      return true;
    },
    sendToSeat(id) {
      calls.push(['sendToSeat', id]);
    },
    sendToBin(id) {
      calls.push(['sendToBin', id]);
      return true;
    },
    showPermissionBubble(id) {
      calls.push(['showPermissionBubble', id]);
    },
    showWaitingBubble(id) {
      calls.push(['showWaitingBubble', id]);
    },
    removeAgent(id) {
      calls.push(['removeAgent', id]);
      characters.delete(id);
    },
    markSessionStart(id) {
      calls.push(['markSessionStart', id]);
    },
    markActivity(id) {
      calls.push(['markActivity', id]);
    },
    markStop(id) {
      calls.push(['markStop', id]);
    },
    cancelVisit(id) {
      calls.push(['cancelVisit', id]);
    },
    logAgentEvent(id, kind, tool, detail) {
      calls.push(['logAgentEvent', id, kind, tool ?? null, detail ?? null]);
    },
  };
  return mock;
}

function makeEvent(partial: Partial<AgentEvent> & Pick<AgentEvent, 'kind' | 'session_id'>): AgentEvent {
  return {
    session_id: partial.session_id,
    source: partial.source ?? 'claude',
    kind: partial.kind,
    tool: partial.tool ?? null,
    cwd: partial.cwd ?? null,
    hook_event_name: partial.hook_event_name ?? null,
    ts_ms: partial.ts_ms ?? 0,
    message: partial.message ?? null,
    command: partial.command ?? null,
  };
}

function methods(calls: Call[]): string[] {
  return calls
    .map((c) => c[0])
    .filter((m) => m !== 'logAgentEvent' && m !== 'setAgentSource' && m !== 'setAgentIdentity');
}

describe('dispatchAgentEvent', () => {
  let office: MockOffice;
  let sessions: SessionAgentMap;

  beforeEach(() => {
    office = createMockOffice();
    sessions = new SessionAgentMap();
  });

  describe('session_start', () => {
    it('adds a new agent for an unseen session', () => {
      dispatchAgentEvent(
        office as unknown as OfficeState,
        makeEvent({ session_id: 's1', kind: 'session_start' }),
        sessions,
      );
      expect(methods(office.calls)).toEqual(['addAgent', 'markSessionStart']);
      expect(office.calls[0][1]).toBe(1);
    });

    it('does not re-add an agent that already exists', () => {
      office.characters.set(1, {});
      // Pre-map the session so sessions.map returns 1
      sessions.map('s1');
      dispatchAgentEvent(
        office as unknown as OfficeState,
        makeEvent({ session_id: 's1', kind: 'session_start' }),
        sessions,
      );
      expect(methods(office.calls)).toEqual(['markSessionStart']);
    });
  });

  describe('pre_tool_use', () => {
    it('routes reading tools to the library bookshelf', () => {
      for (const tool of LIBRARY_TOOLS) {
        office = createMockOffice();
        sessions = new SessionAgentMap();
        dispatchAgentEvent(
          office as unknown as OfficeState,
          makeEvent({ session_id: 'r', kind: 'pre_tool_use', tool }),
          sessions,
        );
        expect(methods(office.calls)).toContain('sendToLibrary');
        expect(methods(office.calls)).not.toContain('sendToSeat');
        expect(office.calls).toContainEqual(['setAgentTool', 1, tool]);
        expect(office.calls).toContainEqual(['setAgentActive', 1, true]);
        expect(office.calls).toContainEqual(['clearBubble', 1]);
      }
    });

    it('routes typing tools to the seat', () => {
      for (const tool of ['Edit', 'Write', 'Bash']) {
        office = createMockOffice();
        sessions = new SessionAgentMap();
        dispatchAgentEvent(
          office as unknown as OfficeState,
          makeEvent({ session_id: 't', kind: 'pre_tool_use', tool }),
          sessions,
        );
        expect(methods(office.calls)).toContain('sendToSeat');
        expect(methods(office.calls)).not.toContain('sendToLibrary');
        expect(office.calls).toContainEqual(['setAgentTool', 1, tool]);
      }
    });

    it('creates the agent if absent before dispatching', () => {
      dispatchAgentEvent(
        office as unknown as OfficeState,
        makeEvent({ session_id: 'fresh', kind: 'pre_tool_use', tool: 'Edit' }),
        sessions,
      );
      expect(methods(office.calls)[0]).toBe('addAgent');
    });

    it('routes Bash `rm …` commands to the bin instead of the seat', () => {
      dispatchAgentEvent(
        office as unknown as OfficeState,
        makeEvent({
          session_id: 's1',
          kind: 'pre_tool_use',
          tool: 'Bash',
          command: 'rm -rf /tmp/scratch',
        }),
        sessions,
      );
      expect(methods(office.calls)).toContain('sendToBin');
      expect(methods(office.calls)).not.toContain('sendToSeat');
    });

    it('non-rm Bash commands still route to the seat', () => {
      dispatchAgentEvent(
        office as unknown as OfficeState,
        makeEvent({
          session_id: 's1',
          kind: 'pre_tool_use',
          tool: 'Bash',
          command: 'npm test',
        }),
        sessions,
      );
      expect(methods(office.calls)).toContain('sendToSeat');
      expect(methods(office.calls)).not.toContain('sendToBin');
    });

    it('word-boundary match — `form` or `farm` do not trigger bin', () => {
      dispatchAgentEvent(
        office as unknown as OfficeState,
        makeEvent({
          session_id: 's1',
          kind: 'pre_tool_use',
          tool: 'Bash',
          command: 'grep -r formdata src/',
        }),
        sessions,
      );
      expect(methods(office.calls)).not.toContain('sendToBin');
    });

    it('does not touch location when tool is missing', () => {
      dispatchAgentEvent(
        office as unknown as OfficeState,
        makeEvent({ session_id: 's', kind: 'pre_tool_use', tool: null }),
        sessions,
      );
      expect(methods(office.calls)).not.toContain('sendToSeat');
      expect(methods(office.calls)).not.toContain('sendToLibrary');
      expect(methods(office.calls)).not.toContain('setAgentTool');
    });
  });

  describe('post_tool_use', () => {
    it('clears only the bubble (not the tool, so reading animation continues mid-walk)', () => {
      sessions.map('s1');
      dispatchAgentEvent(
        office as unknown as OfficeState,
        makeEvent({ session_id: 's1', kind: 'post_tool_use', tool: 'Read' }),
        sessions,
      );
      expect(methods(office.calls)).toEqual(['clearBubble']);
    });
  });

  describe('notification', () => {
    it('shows the permission bubble when the message mentions permission', () => {
      dispatchAgentEvent(
        office as unknown as OfficeState,
        makeEvent({
          session_id: 's1',
          kind: 'notification',
          message: 'Claude needs your permission to use Bash',
        }),
        sessions,
      );
      expect(methods(office.calls)).toContain('showPermissionBubble');
      expect(methods(office.calls)).not.toContain('showWaitingBubble');
    });

    it('shows the waiting bubble for idle reminders', () => {
      dispatchAgentEvent(
        office as unknown as OfficeState,
        makeEvent({
          session_id: 's1',
          kind: 'notification',
          message: 'Claude is waiting for your input',
        }),
        sessions,
      );
      expect(methods(office.calls)).toContain('showWaitingBubble');
      expect(methods(office.calls)).not.toContain('showPermissionBubble');
    });

    it('defaults to the waiting bubble when no message is provided', () => {
      dispatchAgentEvent(
        office as unknown as OfficeState,
        makeEvent({ session_id: 's1', kind: 'notification' }),
        sessions,
      );
      expect(methods(office.calls)).toContain('showWaitingBubble');
    });

    it('creates agent if absent', () => {
      dispatchAgentEvent(
        office as unknown as OfficeState,
        makeEvent({ session_id: 'new', kind: 'notification' }),
        sessions,
      );
      expect(methods(office.calls)[0]).toBe('addAgent');
    });
  });

  describe('stop', () => {
    it('clears active/tool and shows the waiting bubble', () => {
      sessions.map('s1');
      dispatchAgentEvent(
        office as unknown as OfficeState,
        makeEvent({ session_id: 's1', kind: 'stop' }),
        sessions,
      );
      expect(methods(office.calls)).toEqual([
        'cancelVisit',
        'setAgentActive',
        'setAgentTool',
        'showWaitingBubble',
        'markStop',
      ]);
      expect(office.calls[1]).toEqual(['setAgentActive', 1, false]);
      expect(office.calls[2]).toEqual(['setAgentTool', 1, null]);
    });
  });

  describe('sub_agent_stop', () => {
    it('is a no-op (no OfficeState mutation)', () => {
      sessions.map('s1');
      dispatchAgentEvent(
        office as unknown as OfficeState,
        makeEvent({ session_id: 's1', kind: 'sub_agent_stop' }),
        sessions,
      );
      expect(office.calls).toEqual([]);
    });
  });

  describe('session_end', () => {
    it('removes the agent and releases the session id', () => {
      const id = sessions.map('s1');
      expect(id).toBe(1);
      dispatchAgentEvent(
        office as unknown as OfficeState,
        makeEvent({ session_id: 's1', kind: 'session_end' }),
        sessions,
      );
      expect(methods(office.calls)).toEqual(['removeAgent']);
      expect(office.calls[0][1]).toBe(1);
      // Session released → next map() assigns a fresh id
      expect(sessions.map('s1')).toBe(2);
    });

    it('does nothing when the session was never seen', () => {
      dispatchAgentEvent(
        office as unknown as OfficeState,
        makeEvent({ session_id: 'ghost', kind: 'session_end' }),
        sessions,
      );
      expect(office.calls).toEqual([]);
    });
  });
});

describe('SessionAgentMap', () => {
  it('assigns incrementing ids per new session', () => {
    const m = new SessionAgentMap();
    expect(m.map('a')).toBe(1);
    expect(m.map('b')).toBe(2);
    expect(m.map('a')).toBe(1); // stable
  });

  it('release returns the id and removes the mapping', () => {
    const m = new SessionAgentMap();
    m.map('a');
    expect(m.release('a')).toBe(1);
    expect(m.release('a')).toBeNull();
  });

  it('reset clears state and id counter', () => {
    const m = new SessionAgentMap();
    m.map('a');
    m.map('b');
    m.reset();
    expect(m.map('a')).toBe(1);
  });
});
