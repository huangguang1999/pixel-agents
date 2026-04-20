import { beforeEach, describe, expect, it } from 'vitest';

import { WAITING_BUBBLE_DURATION_SEC } from '../constants.js';
import {
  dispatchAgentEvent,
  SessionAgentMap,
  type AgentEvent,
} from '../hooks/agentEventDispatch.js';
import { OfficeState } from '../office/engine/officeState.js';
import { CharacterState, Direction, TileType } from '../office/types.js';
import type { OfficeLayout } from '../office/types.js';

/**
 * Layer 2: integration tests that exercise dispatchAgentEvent against a
 * real OfficeState. Uses a synthetic layout (no furniture — so no seats,
 * but row 11 is walkable so sendToLibrary can pathfind to a bookshelf
 * approach tile).
 */

const COLS = 21;
const ROWS = 22;

/** Build an all-floor interior with wall borders and no furniture. */
function buildOpenLayout(): OfficeLayout {
  const tiles: TileType[] = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (r === 0 || r === ROWS - 1 || c === 0 || c === COLS - 1) {
        tiles.push(TileType.WALL);
      } else {
        tiles.push(TileType.FLOOR_1);
      }
    }
  }
  return { version: 1, cols: COLS, rows: ROWS, tiles, furniture: [] };
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

/** Tick the world forward in small steps until the predicate holds or timeout. */
function tickUntil(
  os: OfficeState,
  predicate: () => boolean,
  maxSeconds = 20,
  dt = 0.1,
): number {
  let elapsed = 0;
  while (elapsed < maxSeconds) {
    if (predicate()) return elapsed;
    os.update(dt);
    elapsed += dt;
  }
  throw new Error(`tickUntil timed out after ${maxSeconds}s`);
}

describe('dispatchAgentEvent (integration with real OfficeState)', () => {
  let os: OfficeState;
  let sessions: SessionAgentMap;

  beforeEach(() => {
    os = new OfficeState(buildOpenLayout());
    sessions = new SessionAgentMap();
  });

  it('session_start creates an agent entity', () => {
    dispatchAgentEvent(os, makeEvent({ session_id: 's1', kind: 'session_start' }), sessions);
    expect(os.characters.has(1)).toBe(true);
  });

  it('session_start with cwd populates folderName (basename) and sessionShortId', () => {
    dispatchAgentEvent(
      os,
      makeEvent({
        // Slice [20, 24) of the dash-stripped hex picks "a7b3" — past the
        // UUIDv7 timestamp prefix so two sessions started in the same ms
        // still diverge here.
        session_id: '00000000-0000-0000-0000-a7b3ffffffff',
        kind: 'session_start',
        cwd: '/Users/me/Documents/code/pixel-agents',
      }),
      sessions,
    );
    const ch = os.characters.get(1)!;
    expect(ch.folderName).toBe('pixel-agents');
    expect(ch.sessionShortId).toBe('a7b3');
  });

  it('Codex UUIDv7 sessions from the same millisecond disambiguate via random tail', () => {
    // Both start with the same 48-bit timestamp prefix ("019da930...") so
    // a naive prefix slice would collide. We slice past it instead.
    dispatchAgentEvent(
      os,
      makeEvent({
        session_id: '019da930-c706-7dd2-b50a-ec71d377ea30',
        kind: 'session_start',
        source: 'codex',
        cwd: '/tmp/a',
      }),
      sessions,
    );
    dispatchAgentEvent(
      os,
      makeEvent({
        session_id: '019da930-cad8-7363-b5db-6aef3af398a0',
        kind: 'session_start',
        source: 'codex',
        cwd: '/tmp/b',
      }),
      sessions,
    );
    const a = os.characters.get(1)!;
    const b = os.characters.get(2)!;
    expect(a.sessionShortId).not.toBe(b.sessionShortId);
  });

  it('trailing slash in cwd does not produce an empty folder name', () => {
    dispatchAgentEvent(
      os,
      makeEvent({
        session_id: 's1',
        kind: 'session_start',
        cwd: '/Users/me/proj/',
      }),
      sessions,
    );
    expect(os.characters.get(1)!.folderName).toBe('proj');
  });

  it('pre_tool_use without a prior session_start still backfills identity', () => {
    dispatchAgentEvent(
      os,
      makeEvent({
        session_id: '00000000-0000-0000-0000-fedc00000000',
        kind: 'pre_tool_use',
        tool: 'Bash',
        cwd: '/tmp/late',
      }),
      sessions,
    );
    const ch = os.characters.get(1)!;
    expect(ch.folderName).toBe('late');
    expect(ch.sessionShortId).toBe('fedc');
  });

  it('notification with permission message sets permission bubble; the bubble persists across a tick', () => {
    dispatchAgentEvent(
      os,
      makeEvent({
        session_id: 's1',
        kind: 'notification',
        message: 'Claude needs your permission to use Bash',
      }),
      sessions,
    );
    const ch = os.characters.get(1)!;
    expect(ch.bubbleType).toBe('permission');

    // Remove from waiting queue so queue-persistence logic doesn't overwrite
    os.waitingQueue = [];
    os.update(0.5);
    expect(ch.bubbleType).toBe('permission');
  });

  it('stop shows a waiting bubble that decays after WAITING_BUBBLE_DURATION_SEC', () => {
    dispatchAgentEvent(os, makeEvent({ session_id: 's1', kind: 'session_start' }), sessions);
    // Clear the "no free seat" queue so waiting-bubble decay isn't re-asserted
    os.waitingQueue = [];
    const ch = os.characters.get(1)!;
    // Skip spawn matrix effect — it pauses the FSM for ~0.3s
    ch.matrixEffect = null;
    ch.matrixEffectTimer = 0;
    ch.bubbleType = null;
    ch.bubbleTimer = 0;

    dispatchAgentEvent(os, makeEvent({ session_id: 's1', kind: 'stop' }), sessions);
    expect(ch.bubbleType).toBe('waiting');
    expect(ch.bubbleTimer).toBeCloseTo(WAITING_BUBBLE_DURATION_SEC, 2);
    expect(ch.isActive).toBe(false);
    expect(ch.currentTool).toBeNull();

    // Tick past the bubble duration — should clear
    for (let i = 0; i < Math.ceil(WAITING_BUBBLE_DURATION_SEC / 0.1) + 2; i++) {
      os.update(0.1);
    }
    expect(ch.bubbleType).toBeNull();
  });

  it('pre_tool_use(WebFetch) sends the agent to the right bookshelf and sets reading pose', () => {
    // Agent id 1 (odd) → right bookshelf (col 9, row 11), facing LEFT
    dispatchAgentEvent(os, makeEvent({ session_id: 's1', kind: 'session_start' }), sessions);
    os.waitingQueue = [];
    const ch = os.characters.get(1)!;
    ch.matrixEffect = null;
    ch.matrixEffectTimer = 0;
    ch.bubbleType = null;
    // Fake seatId — the update loop's reading-tool branch is gated on a truthy
    // seatId. The actual Seat is never looked up, so any string works.
    ch.seatId = 'fake-seat';

    dispatchAgentEvent(
      os,
      makeEvent({ session_id: 's1', kind: 'pre_tool_use', tool: 'WebFetch' }),
      sessions,
    );
    expect(ch.currentTool).toBe('WebFetch');
    expect(ch.isActive).toBe(true);
    expect(ch.targetFacingDir).toBe(Direction.LEFT);
    expect(ch.state).toBe(CharacterState.WALK);
    expect(ch.path.length).toBeGreaterThan(0);

    // Walk the agent through until the path completes — arrives at (9, 11)
    tickUntil(os, () => ch.state !== CharacterState.WALK);
    expect(ch.tileCol).toBe(9);
    expect(ch.tileRow).toBe(11);
    // Reading pose: TYPE state + side-facing + reading tool retained
    expect(ch.state).toBe(CharacterState.TYPE);
    expect(ch.dir).toBe(Direction.LEFT);
    expect(ch.currentTool).toBe('WebFetch');
  });

  it('pre_tool_use for even agent id targets the left bookshelf', () => {
    // Spawn id 1 first, then id 2 (even) via session_start
    dispatchAgentEvent(os, makeEvent({ session_id: 's1', kind: 'session_start' }), sessions);
    dispatchAgentEvent(os, makeEvent({ session_id: 's2', kind: 'session_start' }), sessions);
    os.waitingQueue = [];
    const ch2 = os.characters.get(2)!;
    ch2.matrixEffect = null;
    ch2.matrixEffectTimer = 0;
    ch2.seatId = 'fake-seat';

    dispatchAgentEvent(
      os,
      makeEvent({ session_id: 's2', kind: 'pre_tool_use', tool: 'Glob' }),
      sessions,
    );
    expect(ch2.targetFacingDir).toBe(Direction.RIGHT);

    tickUntil(os, () => ch2.state !== CharacterState.WALK, 30);
    expect(ch2.tileCol).toBe(1);
    expect(ch2.tileRow).toBe(11);
    expect(ch2.dir).toBe(Direction.RIGHT);
  });

  it('post_tool_use does not clear the current tool (reading animation survives mid-walk)', () => {
    dispatchAgentEvent(os, makeEvent({ session_id: 's1', kind: 'session_start' }), sessions);
    os.waitingQueue = [];
    const ch = os.characters.get(1)!;

    dispatchAgentEvent(
      os,
      makeEvent({ session_id: 's1', kind: 'pre_tool_use', tool: 'Read' }),
      sessions,
    );
    expect(ch.currentTool).toBe('Read');

    dispatchAgentEvent(
      os,
      makeEvent({ session_id: 's1', kind: 'post_tool_use', tool: 'Read' }),
      sessions,
    );
    // currentTool is intentionally preserved so the agent keeps the reading
    // pose while still walking to the library.
    expect(ch.currentTool).toBe('Read');
    expect(ch.bubbleType).toBeNull();
  });

  it('WALK stalls when the next tile is occupied by another character', () => {
    // Two agents on the same row; agent 1 tries to walk right through
    // agent 2's tile. Without collision, they'd overlap; with it, 1 stalls.
    dispatchAgentEvent(os, makeEvent({ session_id: 's1', kind: 'session_start' }), sessions);
    dispatchAgentEvent(os, makeEvent({ session_id: 's2', kind: 'session_start' }), sessions);
    os.waitingQueue = [];
    const a = os.characters.get(1)!;
    const b = os.characters.get(2)!;
    a.matrixEffect = null; b.matrixEffect = null;
    a.matrixEffectTimer = 0; b.matrixEffectTimer = 0;

    // Place a at (2,11), b at (3,11). Give a a path to (4,11) — must go
    // through (3,11) which is occupied.
    a.tileCol = 2; a.tileRow = 11; a.x = 2.5 * 16; a.y = 11.5 * 16;
    b.tileCol = 3; b.tileRow = 11; b.x = 3.5 * 16; b.y = 11.5 * 16;
    a.state = CharacterState.WALK;
    a.path = [{ col: 3, row: 11 }, { col: 4, row: 11 }];
    a.moveProgress = 0;
    a.stallSec = 0;
    b.state = CharacterState.TYPE; // stationary blocker

    // Tick a few frames — moveProgress shouldn't advance
    for (let i = 0; i < 5; i++) os.update(0.1);
    expect(a.moveProgress).toBe(0);
    expect(a.stallSec).toBeGreaterThan(0);
    expect(a.tileCol).toBe(2); // still on origin tile
  });

  it('WALK drops its path after stalling past WALK_STALL_MAX_SEC so the FSM re-plans', () => {
    dispatchAgentEvent(os, makeEvent({ session_id: 's1', kind: 'session_start' }), sessions);
    dispatchAgentEvent(os, makeEvent({ session_id: 's2', kind: 'session_start' }), sessions);
    os.waitingQueue = [];
    const a = os.characters.get(1)!;
    const b = os.characters.get(2)!;
    a.matrixEffect = null; b.matrixEffect = null;
    a.matrixEffectTimer = 0; b.matrixEffectTimer = 0;
    a.tileCol = 2; a.tileRow = 11;
    b.tileCol = 3; b.tileRow = 11;
    a.state = CharacterState.WALK;
    a.path = [{ col: 3, row: 11 }];
    a.moveProgress = 0;
    a.stallSec = 0;
    b.state = CharacterState.TYPE;

    // Stall for longer than WALK_STALL_MAX_SEC (1.5s) → path should clear
    for (let i = 0; i < 20; i++) os.update(0.1);
    expect(a.path.length).toBe(0);
    expect(a.stallSec).toBe(0); // reset on clear
  });

  it('no stall when another character sits at a tile we are NOT heading into', () => {
    dispatchAgentEvent(os, makeEvent({ session_id: 's1', kind: 'session_start' }), sessions);
    dispatchAgentEvent(os, makeEvent({ session_id: 's2', kind: 'session_start' }), sessions);
    os.waitingQueue = [];
    const a = os.characters.get(1)!;
    const b = os.characters.get(2)!;
    a.matrixEffect = null; b.matrixEffect = null;
    a.matrixEffectTimer = 0; b.matrixEffectTimer = 0;
    // a at (2,11) going to (2,10); b is at an unrelated tile (5,11).
    a.tileCol = 2; a.tileRow = 11; a.x = 2.5 * 16; a.y = 11.5 * 16;
    b.tileCol = 5; b.tileRow = 11;
    a.state = CharacterState.WALK;
    a.path = [{ col: 2, row: 10 }];
    a.moveProgress = 0;
    a.stallSec = 0;

    os.update(0.1);
    expect(a.moveProgress).toBeGreaterThan(0);
    expect(a.stallSec).toBe(0);
  });

  it('sub_agent_stop is a pure no-op', () => {
    dispatchAgentEvent(os, makeEvent({ session_id: 's1', kind: 'session_start' }), sessions);
    const ch = os.characters.get(1)!;
    const snapshot = {
      state: ch.state,
      tileCol: ch.tileCol,
      tileRow: ch.tileRow,
      isActive: ch.isActive,
      currentTool: ch.currentTool,
      bubbleType: ch.bubbleType,
    };

    dispatchAgentEvent(os, makeEvent({ session_id: 's1', kind: 'sub_agent_stop' }), sessions);

    expect({
      state: ch.state,
      tileCol: ch.tileCol,
      tileRow: ch.tileRow,
      isActive: ch.isActive,
      currentTool: ch.currentTool,
      bubbleType: ch.bubbleType,
    }).toEqual(snapshot);
  });

  it('session_end removes the agent (after despawn animation completes)', () => {
    dispatchAgentEvent(os, makeEvent({ session_id: 's1', kind: 'session_start' }), sessions);
    expect(os.characters.has(1)).toBe(true);

    dispatchAgentEvent(os, makeEvent({ session_id: 's1', kind: 'session_end' }), sessions);
    // Despawn animation plays for MATRIX_EFFECT_DURATION_SEC; tick past it
    tickUntil(os, () => !os.characters.has(1), 5);
    expect(os.characters.has(1)).toBe(false);

    // Session released — next event for the same session_id gets a fresh id
    dispatchAgentEvent(os, makeEvent({ session_id: 's1', kind: 'session_start' }), sessions);
    expect(os.characters.has(2)).toBe(true);
  });
});
