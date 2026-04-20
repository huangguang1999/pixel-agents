import { CharacterState } from '../types.js';
import type { Character } from '../types.js';

export type VerbKey =
  | 'entering'
  | 'reading'
  | 'searching'
  | 'fetching'
  | 'editing'
  | 'writing'
  | 'running'
  | 'delegating'
  | 'working'
  | 'asking'
  | 'waiting'
  | 'idle';

const TOOL_VERBS: Record<string, VerbKey> = {
  Read: 'reading',
  Grep: 'searching',
  Glob: 'searching',
  WebSearch: 'searching',
  WebFetch: 'fetching',
  Edit: 'editing',
  NotebookEdit: 'editing',
  Write: 'writing',
  Bash: 'running',
  Task: 'delegating',
};

/** Resolve a character's current state into a single-word verb key.
 * Priority: permission bubble → waiting bubble → active tool → active-no-tool
 * (the "thinking" window between turns where Codex fires UserPromptSubmit
 * but the real PreToolUse hasn't arrived yet) → walking/spawning → idle.
 */
export function verbKeyFor(ch: Character): VerbKey {
  if (ch.bubbleType === 'permission') return 'asking';
  if (ch.bubbleType === 'waiting') return 'waiting';
  if (ch.currentTool) return TOOL_VERBS[ch.currentTool] ?? 'working';
  if (ch.isActive) return 'working';
  if (ch.state === CharacterState.WALK || ch.matrixEffect === 'spawn') return 'entering';
  return 'idle';
}

/** Human-readable identifier for a character in UI lists (dev panel, logs).
 *
 * Rules:
 * - No folder yet → fall back to "#id" (pre-session_start or a CLI that
 *   didn't ship cwd).
 * - folder is unique among the current roster → show just the folder
 *   ("pixel-agents") — keeps the common case uncluttered.
 * - folder collides with another character → disambiguate with the
 *   session's first 4 hex chars ("pixel-agents·a7b3"). The suffix is
 *   stable for the life of the session, so the same agent keeps the
 *   same label across events.
 *
 * Pass the current roster so collision detection is O(n) in the caller,
 * not O(n²) — the panel only iterates once per render. */
export function agentDisplayLabel(
  ch: { id: number; folderName?: string; sessionShortId?: string },
  roster: Iterable<{ id: number; folderName?: string }>,
): string {
  if (!ch.folderName) return `#${ch.id}`;
  let collision = false;
  for (const other of roster) {
    if (other.id !== ch.id && other.folderName === ch.folderName) {
      collision = true;
      break;
    }
  }
  if (collision && ch.sessionShortId) {
    return `${ch.folderName}·${ch.sessionShortId}`;
  }
  return ch.folderName;
}
