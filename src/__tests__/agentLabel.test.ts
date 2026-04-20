import { describe, expect, it } from 'vitest';

import { agentDisplayLabel, verbKeyFor } from '../office/engine/agentLabel.js';
import { CharacterState, Direction } from '../office/types.js';
import type { Character } from '../office/types.js';

/** Build a minimal Character with sensible defaults; overrides merge in. */
function makeCh(overrides: Partial<Character> = {}): Character {
  return {
    id: 1,
    source: 'claude',
    state: CharacterState.TYPE,
    dir: Direction.DOWN,
    x: 0,
    y: 0,
    tileCol: 0,
    tileRow: 0,
    path: [],
    moveProgress: 0,
    stallSec: 0,
    currentTool: null,
    targetFacingDir: null,
    palette: 0,
    hueShift: 0,
    frame: 0,
    frameTimer: 0,
    wanderTimer: 0,
    wanderCount: 0,
    wanderLimit: 3,
    isActive: false,
    seatId: null,
    tempSeatId: null,
    bubbleType: null,
    bubbleTimer: 0,
    seatTimer: 0,
    isSubagent: false,
    parentAgentId: null,
    matrixEffect: null,
    matrixEffectTimer: 0,
    matrixEffectSeeds: [],
    inputTokens: 0,
    outputTokens: 0,
    sessionAgeSec: 0,
    stopIdleSec: null,
    planningSec: null,
    clockCooldownSec: 0,
    hasVisitedCoolerThisSession: false,
    visitKind: null,
    visitReturnSec: 0,
    ...overrides,
  };
}

describe('verbKeyFor', () => {
  it('permission bubble wins over everything', () => {
    const ch = makeCh({
      bubbleType: 'permission',
      currentTool: 'Edit',
      state: CharacterState.WALK,
    });
    expect(verbKeyFor(ch)).toBe('asking');
  });

  it('waiting bubble wins over tool + walk', () => {
    const ch = makeCh({
      bubbleType: 'waiting',
      currentTool: 'Bash',
      state: CharacterState.WALK,
    });
    expect(verbKeyFor(ch)).toBe('waiting');
  });

  it('maps Read → reading', () => {
    expect(verbKeyFor(makeCh({ currentTool: 'Read' }))).toBe('reading');
  });

  it('Grep / Glob / WebSearch all collapse to searching', () => {
    expect(verbKeyFor(makeCh({ currentTool: 'Grep' }))).toBe('searching');
    expect(verbKeyFor(makeCh({ currentTool: 'Glob' }))).toBe('searching');
    expect(verbKeyFor(makeCh({ currentTool: 'WebSearch' }))).toBe('searching');
  });

  it('WebFetch → fetching', () => {
    expect(verbKeyFor(makeCh({ currentTool: 'WebFetch' }))).toBe('fetching');
  });

  it('Edit and NotebookEdit both map to editing', () => {
    expect(verbKeyFor(makeCh({ currentTool: 'Edit' }))).toBe('editing');
    expect(verbKeyFor(makeCh({ currentTool: 'NotebookEdit' }))).toBe('editing');
  });

  it('Write → writing, Bash → running, Task → delegating', () => {
    expect(verbKeyFor(makeCh({ currentTool: 'Write' }))).toBe('writing');
    expect(verbKeyFor(makeCh({ currentTool: 'Bash' }))).toBe('running');
    expect(verbKeyFor(makeCh({ currentTool: 'Task' }))).toBe('delegating');
  });

  it('unknown tool falls back to generic working', () => {
    expect(verbKeyFor(makeCh({ currentTool: 'MysteryTool' }))).toBe('working');
  });

  it('walking without a tool reads as entering', () => {
    expect(verbKeyFor(makeCh({ state: CharacterState.WALK }))).toBe('entering');
  });

  it('spawn matrix effect reads as entering', () => {
    expect(verbKeyFor(makeCh({ matrixEffect: 'spawn' }))).toBe('entering');
  });

  it('seated with no tool, no bubble → idle', () => {
    expect(verbKeyFor(makeCh({ state: CharacterState.TYPE }))).toBe('idle');
  });

  it('active with no tool yet (Codex thinking window) → working, not idle', () => {
    // Codex fires UserPromptSubmit → pre_tool_use(tool=None) which flips
    // isActive=true before the real PreToolUse lands. We should not briefly
    // render "idle" during this gap.
    expect(verbKeyFor(makeCh({ isActive: true, currentTool: null }))).toBe('working');
  });

  it('active flag does not override an explicit tool verb', () => {
    // Bash still reads as 'running' even when isActive is on.
    expect(
      verbKeyFor(makeCh({ isActive: true, currentTool: 'Bash' })),
    ).toBe('running');
  });
});

describe('agentDisplayLabel', () => {
  it('no folder yet → falls back to #id', () => {
    const ch = { id: 7, folderName: undefined, sessionShortId: 'a7b3' };
    expect(agentDisplayLabel(ch, [ch])).toBe('#7');
  });

  it('unique folder → plain folder name, no suffix', () => {
    const roster = [
      { id: 1, folderName: 'pixel-agents' },
      { id: 2, folderName: 'btc-signal' },
    ];
    expect(
      agentDisplayLabel({ id: 1, folderName: 'pixel-agents', sessionShortId: 'a7b3' }, roster),
    ).toBe('pixel-agents');
  });

  it('collision → appends session short id', () => {
    const roster = [
      { id: 1, folderName: 'pixel-agents' },
      { id: 2, folderName: 'pixel-agents' },
    ];
    expect(
      agentDisplayLabel({ id: 1, folderName: 'pixel-agents', sessionShortId: 'a7b3' }, roster),
    ).toBe('pixel-agents·a7b3');
    expect(
      agentDisplayLabel({ id: 2, folderName: 'pixel-agents', sessionShortId: 'b2c9' }, roster),
    ).toBe('pixel-agents·b2c9');
  });

  it('collision without session id → still shows plain folder (no junk suffix)', () => {
    const roster = [
      { id: 1, folderName: 'x' },
      { id: 2, folderName: 'x' },
    ];
    expect(agentDisplayLabel({ id: 1, folderName: 'x' }, roster)).toBe('x');
  });

  it('self-only roster with matching folder is not a collision', () => {
    const ch = { id: 1, folderName: 'solo', sessionShortId: 'dead' };
    expect(agentDisplayLabel(ch, [ch])).toBe('solo');
  });
});
