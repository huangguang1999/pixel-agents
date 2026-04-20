import {
  AUTO_ON_FACING_DEPTH,
  AUTO_ON_SIDE_DEPTH,
  BUBBLE_FADE_DURATION_SEC,
  CHARACTER_HIT_HALF_WIDTH,
  CHARACTER_HIT_HEIGHT,
  CHARACTER_SITTING_OFFSET_PX,
  DISMISS_BUBBLE_FAST_FADE_SEC,
  FURNITURE_ANIM_INTERVAL_SEC,
  HUE_SHIFT_MIN_DEG,
  HUE_SHIFT_RANGE_DEG,
  INACTIVE_SEAT_TIMER_MIN_SEC,
  INACTIVE_SEAT_TIMER_RANGE_SEC,
  WAITING_BUBBLE_DURATION_SEC,
} from '../../constants.js';
import { getAnimationFrames, getCatalogEntry, getOnStateType } from '../layout/furnitureCatalog.js';
import {
  createDefaultLayout,
  getBlockedTiles,
  layoutToFurnitureInstances,
  layoutToSeats,
  layoutToTileMap,
} from '../layout/layoutSerializer.js';
import { findPath, getWalkableTiles, isWalkable } from '../layout/tileMap.js';
import { getLoadedCharacterCount } from '../sprites/spriteData.js';
import type {
  Character,
  FurnitureInstance,
  OfficeLayout,
  PlacedFurniture,
  Seat,
  TileType as TileTypeVal,
} from '../types.js';
import { CharacterState, Direction, MATRIX_EFFECT_DURATION, TILE_SIZE } from '../types.js';
import { createCharacter, updateCharacter } from './characters.js';
import { matrixEffectSeeds } from './matrixEffect.js';

// -- Ambient behavior thresholds (seconds) --
const STOP_IDLE_TRIGGER_SEC = 60;
const LONG_SESSION_THRESHOLD_SEC = 15 * 60;
const PLANNING_TRIGGER_SEC = 5;
const CLOCK_GLANCE_INTERVAL_SEC = 10 * 60;
const CLOCK_GLANCE_CHANCE = 0.3;
const COOLER_LINGER_SEC = 3;
const CLOCK_LINGER_SEC = 1;
const BIN_LINGER_SEC = 2;
/** Furniture approach offsets for ambient visits. Mirrors MockEventPanel's WALK_SPEC. */
const AMBIENT_APPROACH: Record<
  'BIN' | 'WATER_COOLER' | 'CLOCK' | 'WHITEBOARD',
  { dx: number; dy: number }
> = {
  BIN:          { dx:  1, dy:  0 },
  WATER_COOLER: { dx:  0, dy: -1 },
  CLOCK:        { dx:  0, dy:  2 },
  WHITEBOARD:   { dx:  0, dy:  2 },
};

/** Max entries kept per agent in the event log (ring buffer). */
export const AGENT_LOG_CAP = 200;

/** One line in an agent's event log. */
export interface AgentLogEntry {
  ts: number;
  kind: string;
  tool?: string | null;
  detail?: string | null;
}

export class OfficeState {
  layout: OfficeLayout;
  tileMap: TileTypeVal[][];
  seats: Map<string, Seat>;
  blockedTiles: Set<string>;
  furniture: FurnitureInstance[];
  walkableTiles: Array<{ col: number; row: number }>;
  characters: Map<number, Character> = new Map();
  /** Accumulated time for furniture animation frame cycling */
  furnitureAnimTimer = 0;
  selectedAgentId: number | null = null;
  hoveredAgentId: number | null = null;
  hoveredTile: { col: number; row: number } | null = null;
  /** Maps "parentId:toolId" → sub-agent character ID (negative) */
  subagentIdMap: Map<string, number> = new Map();
  /** Reverse lookup: sub-agent character ID → parent info */
  subagentMeta: Map<number, { parentAgentId: number; parentToolId: string }> = new Map();
  private nextSubagentId = -1;
  /** FIFO queue of agent ids waiting for a seat (when office is over capacity) */
  waitingQueue: number[] = [];
  /** Per-agent ring-buffered hook event log. Appended by dispatchAgentEvent. */
  agentLogs: Map<number, AgentLogEntry[]> = new Map();

  constructor(layout?: OfficeLayout) {
    this.layout = layout || createDefaultLayout();
    this.tileMap = layoutToTileMap(this.layout);
    this.seats = layoutToSeats(this.layout.furniture);
    this.blockedTiles = getBlockedTiles(this.layout.furniture);
    this.furniture = layoutToFurnitureInstances(this.layout.furniture);
    this.walkableTiles = getWalkableTiles(this.tileMap, this.blockedTiles);
  }

  /** Rebuild all derived state from a new layout. Reassigns existing characters.
   *  @param shift Optional pixel shift to apply when grid expands left/up */
  rebuildFromLayout(layout: OfficeLayout, shift?: { col: number; row: number }): void {
    this.layout = layout;
    this.tileMap = layoutToTileMap(layout);
    this.seats = layoutToSeats(layout.furniture);
    this.blockedTiles = getBlockedTiles(layout.furniture);
    this.rebuildFurnitureInstances();
    this.walkableTiles = getWalkableTiles(this.tileMap, this.blockedTiles);

    // Shift character positions when grid expands left/up
    if (shift && (shift.col !== 0 || shift.row !== 0)) {
      for (const ch of this.characters.values()) {
        ch.tileCol += shift.col;
        ch.tileRow += shift.row;
        ch.x += shift.col * TILE_SIZE;
        ch.y += shift.row * TILE_SIZE;
        // Clear path since tile coords changed
        ch.path = [];
        ch.moveProgress = 0;
      }
    }

    // Reassign characters to new seats, preserving existing assignments when possible
    for (const seat of this.seats.values()) {
      seat.assigned = false;
    }

    // First pass: try to keep characters at their existing seats
    for (const ch of this.characters.values()) {
      if (ch.seatId && this.seats.has(ch.seatId)) {
        const seat = this.seats.get(ch.seatId)!;
        if (!seat.assigned) {
          seat.assigned = true;
          // Snap character to seat position
          ch.tileCol = seat.seatCol;
          ch.tileRow = seat.seatRow;
          const cx = seat.seatCol * TILE_SIZE + TILE_SIZE / 2;
          const cy = seat.seatRow * TILE_SIZE + TILE_SIZE / 2;
          ch.x = cx;
          ch.y = cy;
          ch.dir = seat.facingDir;
          continue;
        }
      }
      ch.seatId = null; // will be reassigned below
    }

    // Second pass: assign remaining characters to free seats
    for (const ch of this.characters.values()) {
      if (ch.seatId) continue;
      const seatId = this.findFreeSeat();
      if (seatId) {
        this.seats.get(seatId)!.assigned = true;
        ch.seatId = seatId;
        const seat = this.seats.get(seatId)!;
        ch.tileCol = seat.seatCol;
        ch.tileRow = seat.seatRow;
        ch.x = seat.seatCol * TILE_SIZE + TILE_SIZE / 2;
        ch.y = seat.seatRow * TILE_SIZE + TILE_SIZE / 2;
        ch.dir = seat.facingDir;
      }
    }

    // Relocate any characters that ended up outside bounds or on non-walkable tiles
    for (const ch of this.characters.values()) {
      if (ch.seatId) continue; // seated characters are fine
      if (
        ch.tileCol < 0 ||
        ch.tileCol >= layout.cols ||
        ch.tileRow < 0 ||
        ch.tileRow >= layout.rows
      ) {
        this.relocateCharacterToWalkable(ch);
      }
    }
  }

  /** Move a character to a random walkable tile */
  private relocateCharacterToWalkable(ch: Character): void {
    if (this.walkableTiles.length === 0) return;
    const spawn = this.walkableTiles[Math.floor(Math.random() * this.walkableTiles.length)];
    ch.tileCol = spawn.col;
    ch.tileRow = spawn.row;
    ch.x = spawn.col * TILE_SIZE + TILE_SIZE / 2;
    ch.y = spawn.row * TILE_SIZE + TILE_SIZE / 2;
    ch.path = [];
    ch.moveProgress = 0;
  }

  getLayout(): OfficeLayout {
    return this.layout;
  }

  /** Get the blocked-tile key for a character's own seat, or null */
  private ownSeatKey(ch: Character): string | null {
    if (!ch.seatId) return null;
    const seat = this.seats.get(ch.seatId);
    if (!seat) return null;
    return `${seat.seatCol},${seat.seatRow}`;
  }

  /** Temporarily unblock a character's own seat, run fn, then re-block */
  private withOwnSeatUnblocked<T>(ch: Character, fn: () => T): T {
    const key = this.ownSeatKey(ch);
    if (key) this.blockedTiles.delete(key);
    const result = fn();
    if (key) this.blockedTiles.add(key);
    return result;
  }

  private findFreeSeat(): string | null {
    // Build set of tiles occupied by electronics (PCs, monitors, etc.)
    const electronicsTiles = new Set<string>();
    for (const item of this.layout.furniture) {
      const entry = getCatalogEntry(item.type);
      if (!entry || entry.category !== 'electronics') continue;
      for (let dr = 0; dr < entry.footprintH; dr++) {
        for (let dc = 0; dc < entry.footprintW; dc++) {
          electronicsTiles.add(`${item.col + dc},${item.row + dr}`);
        }
      }
    }

    // Collect free seats, split into those facing electronics and the rest
    const pcSeats: string[] = [];
    const otherSeats: string[] = [];
    for (const [uid, seat] of this.seats) {
      if (seat.assigned) continue;

      // Check if this seat faces electronics (same logic as auto-state detection)
      let facesPC = false;
      const dCol =
        seat.facingDir === Direction.RIGHT ? 1 : seat.facingDir === Direction.LEFT ? -1 : 0;
      const dRow = seat.facingDir === Direction.DOWN ? 1 : seat.facingDir === Direction.UP ? -1 : 0;
      for (let d = 1; d <= AUTO_ON_FACING_DEPTH && !facesPC; d++) {
        const tileCol = seat.seatCol + dCol * d;
        const tileRow = seat.seatRow + dRow * d;
        if (electronicsTiles.has(`${tileCol},${tileRow}`)) {
          facesPC = true;
          break;
        }
        if (dCol !== 0) {
          if (
            electronicsTiles.has(`${tileCol},${tileRow - 1}`) ||
            electronicsTiles.has(`${tileCol},${tileRow + 1}`)
          ) {
            facesPC = true;
            break;
          }
        } else {
          if (
            electronicsTiles.has(`${tileCol - 1},${tileRow}`) ||
            electronicsTiles.has(`${tileCol + 1},${tileRow}`)
          ) {
            facesPC = true;
            break;
          }
        }
      }
      (facesPC ? pcSeats : otherSeats).push(uid);
    }

    // Pick randomly: prefer PC seats, then any seat
    if (pcSeats.length > 0) return pcSeats[Math.floor(Math.random() * pcSeats.length)];
    if (otherSeats.length > 0) return otherSeats[Math.floor(Math.random() * otherSeats.length)];
    return null;
  }

  /**
   * Pick a diverse palette for a new agent based on currently active agents.
   * First 6 agents each get a unique skin (random order). Beyond 6, skins
   * repeat in balanced rounds with a random hue shift (≥45°).
   */
  private pickDiversePalette(): { palette: number; hueShift: number } {
    // Count how many non-sub-agents use each base palette (0-5)
    const paletteCount = getLoadedCharacterCount();
    const counts = new Array(paletteCount).fill(0) as number[];
    for (const ch of this.characters.values()) {
      if (ch.isSubagent) continue;
      if (ch.palette < paletteCount) counts[ch.palette]++;
    }
    const minCount = Math.min(...counts);
    // Available = palettes at the minimum count (least used)
    const available: number[] = [];
    for (let i = 0; i < paletteCount; i++) {
      if (counts[i] === minCount) available.push(i);
    }
    const palette = available[Math.floor(Math.random() * available.length)];
    // First round (minCount === 0): no hue shift. Subsequent rounds: random ≥45°.
    let hueShift = 0;
    if (minCount > 0) {
      hueShift = HUE_SHIFT_MIN_DEG + Math.floor(Math.random() * HUE_SHIFT_RANGE_DEG);
    }
    return { palette, hueShift };
  }

  addAgent(
    id: number,
    preferredPalette?: number,
    preferredHueShift?: number,
    preferredSeatId?: string,
    skipSpawnEffect?: boolean,
    folderName?: string,
  ): void {
    if (this.characters.has(id)) return;

    let palette: number;
    let hueShift: number;
    if (preferredPalette !== undefined) {
      palette = preferredPalette;
      hueShift = preferredHueShift ?? 0;
    } else {
      const pick = this.pickDiversePalette();
      palette = pick.palette;
      hueShift = pick.hueShift;
    }

    // Try preferred seat first, then any free seat
    let seatId: string | null = null;
    if (preferredSeatId && this.seats.has(preferredSeatId)) {
      const seat = this.seats.get(preferredSeatId)!;
      if (!seat.assigned) {
        seatId = preferredSeatId;
      }
    }
    if (!seatId) {
      seatId = this.findFreeSeat();
    }

    let ch: Character;
    if (seatId) {
      const seat = this.seats.get(seatId)!;
      seat.assigned = true;
      ch = createCharacter(id, palette, seatId, seat, hueShift);
      // Entrance walk-in: spawn just inside the door, FSM will pathfind to seat
      if (!skipSpawnEffect) {
        const DOOR_COL = 14;
        const DOOR_ROW = 11;
        if (isWalkable(DOOR_COL, DOOR_ROW, this.tileMap, this.blockedTiles)) {
          ch.x = DOOR_COL * TILE_SIZE + TILE_SIZE / 2;
          ch.y = DOOR_ROW * TILE_SIZE + TILE_SIZE / 2;
          ch.tileCol = DOOR_COL;
          ch.tileRow = DOOR_ROW;
          ch.state = CharacterState.IDLE;
          ch.dir = Direction.DOWN;
        }
      }
    } else {
      // No seats — spawn at random walkable tile, enqueue for next free seat
      const spawn =
        this.walkableTiles.length > 0
          ? this.walkableTiles[Math.floor(Math.random() * this.walkableTiles.length)]
          : { col: 1, row: 1 };
      ch = createCharacter(id, palette, null, null, hueShift);
      ch.x = spawn.col * TILE_SIZE + TILE_SIZE / 2;
      ch.y = spawn.row * TILE_SIZE + TILE_SIZE / 2;
      ch.tileCol = spawn.col;
      ch.tileRow = spawn.row;
      ch.bubbleType = 'waiting';
      ch.isActive = false;
      if (!this.waitingQueue.includes(id)) this.waitingQueue.push(id);
    }

    if (folderName) {
      ch.folderName = folderName;
    }
    if (!skipSpawnEffect) {
      ch.matrixEffect = 'spawn';
      ch.matrixEffectTimer = 0;
      ch.matrixEffectSeeds = matrixEffectSeeds();
    }
    this.characters.set(id, ch);
  }

  removeAgent(id: number): void {
    const ch = this.characters.get(id);
    if (!ch) return;
    if (ch.matrixEffect === 'despawn') return; // already despawning
    // If this agent was queued for a seat, drop it from the queue
    const qIdx = this.waitingQueue.indexOf(id);
    if (qIdx >= 0) this.waitingQueue.splice(qIdx, 1);
    // Free seat and clear selection immediately
    if (ch.seatId) {
      const seat = this.seats.get(ch.seatId);
      if (seat) seat.assigned = false;
    }
    if (this.selectedAgentId === id) this.selectedAgentId = null;
    // Start despawn animation instead of immediate delete
    ch.matrixEffect = 'despawn';
    ch.matrixEffectTimer = 0;
    ch.matrixEffectSeeds = matrixEffectSeeds();
    ch.bubbleType = null;
    this.promoteQueueHead();
  }

  /** Append an event to an agent's ring-buffered log (cap AGENT_LOG_CAP). */
  logAgentEvent(id: number, kind: string, tool?: string | null, detail?: string | null): void {
    let buf = this.agentLogs.get(id);
    if (!buf) {
      buf = [];
      this.agentLogs.set(id, buf);
    }
    buf.push({ ts: Date.now(), kind, tool: tool ?? null, detail: detail ?? null });
    if (buf.length > AGENT_LOG_CAP) buf.splice(0, buf.length - AGENT_LOG_CAP);
  }

  /** Dequeue the head waiting agent and walk them to any free seat. */
  private promoteQueueHead(): void {
    while (this.waitingQueue.length > 0) {
      const nextId = this.waitingQueue[0];
      const ch = this.characters.get(nextId);
      if (!ch || ch.matrixEffect === 'despawn') {
        this.waitingQueue.shift();
        continue;
      }
      const seatId = this.findFreeSeat();
      if (!seatId) return;
      this.waitingQueue.shift();
      if (ch.bubbleType === 'waiting') ch.bubbleType = null;
      this.reassignSeat(nextId, seatId);
      return;
    }
  }

  /** Find seat uid at a given tile position, or null */
  getSeatAtTile(col: number, row: number): string | null {
    for (const [uid, seat] of this.seats) {
      if (seat.seatCol === col && seat.seatRow === row) return uid;
    }
    return null;
  }

  /** Reassign an agent from their current seat to a new seat */
  reassignSeat(agentId: number, seatId: string): void {
    const ch = this.characters.get(agentId);
    if (!ch) return;
    // Unassign old seat
    if (ch.seatId) {
      const old = this.seats.get(ch.seatId);
      if (old) old.assigned = false;
    }
    // Assign new seat
    const seat = this.seats.get(seatId);
    if (!seat || seat.assigned) return;
    seat.assigned = true;
    ch.seatId = seatId;
    this.routeToSeat(ch, seat);
  }

  /** Send an agent back to their currently assigned seat */
  sendToSeat(agentId: number): void {
    const ch = this.characters.get(agentId);
    if (!ch || !ch.seatId) return;
    ch.tempSeatId = null;
    const seat = this.seats.get(ch.seatId);
    if (!seat) return;
    this.routeToSeat(ch, seat);
  }

  /** Drive a character toward its assigned `seat`. Three outcomes:
   *  - path found → WALK along it
   *  - no path AND already on the seat tile → sit down (TYPE)
   *  - no path AND off the seat tile → leave state alone; the seat
   *    assignment itself is kept so a future retry (layout edit, path
   *    reopens) can land them there. Previously these last two collapsed
   *    into the same branch and caused the agent to start "typing" in
   *    mid-air wherever they happened to stand. */
  private routeToSeat(ch: Character, seat: Seat): void {
    const path = this.withOwnSeatUnblocked(ch, () =>
      findPath(ch.tileCol, ch.tileRow, seat.seatCol, seat.seatRow, this.tileMap, this.blockedTiles),
    );
    if (path.length > 0) {
      ch.path = path;
      ch.moveProgress = 0;
      ch.state = CharacterState.WALK;
      ch.frame = 0;
      ch.frameTimer = 0;
      return;
    }
    const atSeat = ch.tileCol === seat.seatCol && ch.tileRow === seat.seatRow;
    if (!atSeat) {
      // Unreachable right now — don't snap into a sit-and-type pose off-seat.
      return;
    }
    ch.state = CharacterState.TYPE;
    ch.dir = seat.facingDir;
    ch.frame = 0;
    ch.frameTimer = 0;
    if (!ch.isActive) {
      ch.seatTimer = INACTIVE_SEAT_TIMER_MIN_SEC + Math.random() * INACTIVE_SEAT_TIMER_RANGE_SEC;
    }
  }

  /**
   * Route an agent to a library bookshelf for side-profile reading.
   * Alternates L/R based on agent id parity so multiple agents don't stack.
   * Returns whether the walk was dispatched.
   */
  sendToLibrary(agentId: number): boolean {
    const ch = this.characters.get(agentId);
    if (!ch || ch.isSubagent) return false;
    ch.tempSeatId = null;
    // Bookshelves occupy (cols 2-3, 7-8) × rows 9-10. Row 10 is fully blocked
    // by wall furniture (clock/whiteboard/plants), so approach from row 11 at
    // the outside col (1 west of left shelf, 9 east of right shelf) and face
    // inward toward the shelf for a side-profile reading pose.
    const usingRight = agentId % 2 === 1;
    const col = usingRight ? 9 : 1;
    const dir = usingRight ? Direction.LEFT : Direction.RIGHT;
    const row = 11;
    if (!this.walkToTile(agentId, col, row)) return false;
    ch.targetFacingDir = dir;
    return true;
  }

  /**
   * Route an agent to a free sofa/bench seat in the lounge area. On arrival
   * they sit down temporarily (dir from seat); does NOT change `seatId`.
   * Returns whether a walk was dispatched (or they were already there).
   */
  sendToLounge(agentId: number): boolean {
    const ch = this.characters.get(agentId);
    if (!ch || ch.isSubagent) return false;

    // Lounge = sofa only. Benches/cushioned chairs live in other zones
    // (library, work desks) and shouldn't steal the "→ 休息区" click.
    const loungeUids = new Set<string>();
    for (const f of this.layout.furniture) {
      if (/^SOFA(_|$|:)/.test(f.type)) {
        loungeUids.add(f.uid);
      }
    }
    const claimed = new Set<string>();
    for (const other of this.characters.values()) {
      if (other.id === agentId) continue;
      if (other.tempSeatId) claimed.add(other.tempSeatId);
      if (other.seatId) claimed.add(other.seatId);
    }

    let bestSeatId: string | null = null;
    let bestDist = Infinity;
    for (const [seatUid, seat] of this.seats) {
      // Seat uid is either furniture uid or "{uid}:{n}"
      const ownerUid = seatUid.split(':')[0];
      if (!loungeUids.has(ownerUid)) continue;
      if (claimed.has(seatUid)) continue;
      const d =
        Math.abs(seat.seatCol - ch.tileCol) + Math.abs(seat.seatRow - ch.tileRow);
      if (d < bestDist) {
        bestDist = d;
        bestSeatId = seatUid;
      }
    }
    if (!bestSeatId) return false;
    const target = this.seats.get(bestSeatId)!;
    const targetKey = `${target.seatCol},${target.seatRow}`;
    const ownKey = this.ownSeatKey(ch);
    this.blockedTiles.delete(targetKey);
    if (ownKey) this.blockedTiles.delete(ownKey);
    const path = findPath(
      ch.tileCol,
      ch.tileRow,
      target.seatCol,
      target.seatRow,
      this.tileMap,
      this.blockedTiles,
    );
    if (ownKey) this.blockedTiles.add(ownKey);
    this.blockedTiles.add(targetKey);

    ch.tempSeatId = bestSeatId;
    if (path.length === 0) {
      if (ch.tileCol === target.seatCol && ch.tileRow === target.seatRow) {
        // Already there — sit immediately
        ch.state = CharacterState.TYPE;
        ch.dir = target.facingDir;
        ch.frame = 0;
        ch.frameTimer = 0;
        return true;
      }
      ch.tempSeatId = null;
      return false;
    }
    ch.path = path;
    ch.moveProgress = 0;
    ch.state = CharacterState.WALK;
    ch.frame = 0;
    ch.frameTimer = 0;
    return true;
  }

  /** Resolve the approach tile for the first instance of a furniture type in
   *  the layout, using the preconfigured `AMBIENT_APPROACH` offsets. Returns
   *  null when the furniture isn't present or the computed tile is out of range. */
  private findAmbientApproach(
    type: keyof typeof AMBIENT_APPROACH,
  ): { col: number; row: number } | null {
    const match = this.layout.furniture.find((f) => f.type === type);
    if (!match) return null;
    const off = AMBIENT_APPROACH[type];
    return { col: match.col + off.dx, row: match.row + off.dy };
  }

  /** Dispatch an ambient visit: walk the agent to `target`, tag the character
   *  with `kind`, and schedule an auto-return after `lingerSec` (0 = stay
   *  until explicitly preempted — whiteboard / lounge case). */
  private dispatchVisit(
    agentId: number,
    kind: NonNullable<Character['visitKind']>,
    target: { col: number; row: number },
    lingerSec: number,
  ): boolean {
    const ch = this.characters.get(agentId);
    if (!ch || ch.isSubagent) return false;
    if (!this.walkToTile(agentId, target.col, target.row)) return false;
    ch.visitKind = kind;
    ch.visitReturnSec = lingerSec;
    return true;
  }

  /** Walk to the bin and linger briefly (used when a Bash command is an `rm`). */
  sendToBin(agentId: number, lingerSec = BIN_LINGER_SEC): boolean {
    const t = this.findAmbientApproach('BIN');
    if (!t) return false;
    return this.dispatchVisit(agentId, 'bin', t, lingerSec);
  }

  /** Walk to the water cooler and come back (long-session break). */
  sendToCooler(agentId: number, lingerSec = COOLER_LINGER_SEC): boolean {
    const t = this.findAmbientApproach('WATER_COOLER');
    if (!t) return false;
    return this.dispatchVisit(agentId, 'cooler', t, lingerSec);
  }

  /** Brief glance at the wall clock (ambient, during long idle periods). */
  sendToClock(agentId: number, lingerSec = CLOCK_LINGER_SEC): boolean {
    const t = this.findAmbientApproach('CLOCK');
    if (!t) return false;
    return this.dispatchVisit(agentId, 'clock', t, lingerSec);
  }

  /** Stand facing the whiteboard; persists until a PreToolUse preempts. */
  sendToWhiteboard(agentId: number): boolean {
    const t = this.findAmbientApproach('WHITEBOARD');
    if (!t) return false;
    return this.dispatchVisit(agentId, 'whiteboard', t, 0);
  }

  // -- Dispatcher-facing ambient-behavior hooks --

  /** Call on session_start: arms the planning-timer → whiteboard trigger. */
  markSessionStart(agentId: number): void {
    const ch = this.characters.get(agentId);
    if (!ch) return;
    ch.planningSec = 0;
    ch.stopIdleSec = null;
    ch.sessionAgeSec = 0;
    ch.hasVisitedCoolerThisSession = false;
  }

  /** Call on any real tool-use activity: cancels pending whiteboard / idle timers. */
  markActivity(agentId: number): void {
    const ch = this.characters.get(agentId);
    if (!ch) return;
    ch.planningSec = null;
    ch.stopIdleSec = null;
    ch.clockCooldownSec = 0;
  }

  /** Call on Stop: starts the "idle more than 60s → walk to lounge" timer. */
  markStop(agentId: number): void {
    const ch = this.characters.get(agentId);
    if (!ch) return;
    ch.stopIdleSec = 0;
    ch.planningSec = null;
  }

  /** If the agent is on an ambient visit, send them back to their seat and
   *  clear the marker. No-op otherwise. Used to preempt visits on PreToolUse / Stop. */
  cancelVisit(agentId: number): void {
    const ch = this.characters.get(agentId);
    if (!ch || ch.visitKind === null) return;
    ch.visitKind = null;
    ch.visitReturnSec = 0;
    // Return to seat only if the agent has one — sub-agents / queued spawners don't.
    if (ch.seatId) this.sendToSeat(agentId);
  }

  /** Advance timers that drive whiteboard / lounge / cooler / clock visits
   *  for one character. Called per-tick from `update` on real agents. */
  private tickAmbientBehaviors(ch: Character, dt: number): void {
    if (ch.isSubagent || ch.matrixEffect) return;
    ch.sessionAgeSec += dt;

    // Linger countdown — effective only after arrival at the visit tile.
    if (
      ch.visitKind !== null &&
      ch.visitReturnSec > 0 &&
      ch.state === CharacterState.TYPE &&
      ch.path.length === 0
    ) {
      ch.visitReturnSec -= dt;
      if (ch.visitReturnSec <= 0) {
        const kind = ch.visitKind;
        ch.visitReturnSec = 0;
        ch.visitKind = null;
        if (kind === 'cooler') ch.hasVisitedCoolerThisSession = true;
        if (ch.seatId) this.sendToSeat(ch.id);
      }
    }

    // Planning → whiteboard: first PreToolUse that doesn't come within ~5s of
    // SessionStart pushes the agent to stand at the whiteboard.
    if (ch.planningSec !== null) {
      ch.planningSec += dt;
      if (
        ch.planningSec >= PLANNING_TRIGGER_SEC &&
        ch.visitKind === null &&
        !ch.isActive
      ) {
        ch.planningSec = null;
        this.sendToWhiteboard(ch.id);
      }
    }

    // Stop-idle → lounge (or cooler detour the first time in a long session).
    if (ch.stopIdleSec !== null) {
      ch.stopIdleSec += dt;
      if (
        ch.stopIdleSec >= STOP_IDLE_TRIGGER_SEC &&
        ch.visitKind === null &&
        !ch.isActive
      ) {
        ch.stopIdleSec = null;
        if (
          ch.sessionAgeSec >= LONG_SESSION_THRESHOLD_SEC &&
          !ch.hasVisitedCoolerThisSession
        ) {
          this.sendToCooler(ch.id);
        } else if (this.sendToLounge(ch.id)) {
          ch.visitKind = 'lounge';
        }
      }
    }

    // Ambient clock glance — purely decorative, fires while sitting idle at
    // own seat once the agent has been at work long enough to warrant it.
    if (
      !ch.isActive &&
      ch.state === CharacterState.TYPE &&
      ch.seatId &&
      !ch.tempSeatId &&
      ch.visitKind === null
    ) {
      ch.clockCooldownSec += dt;
      if (ch.clockCooldownSec >= CLOCK_GLANCE_INTERVAL_SEC) {
        ch.clockCooldownSec = 0;
        if (Math.random() < CLOCK_GLANCE_CHANCE) {
          this.sendToClock(ch.id);
        }
      }
    }
  }

  /** Walk an agent to an arbitrary walkable tile (right-click command) */
  walkToTile(agentId: number, col: number, row: number): boolean {
    const ch = this.characters.get(agentId);
    if (!ch || ch.isSubagent) return false;
    ch.tempSeatId = null;
    if (!isWalkable(col, row, this.tileMap, this.blockedTiles)) {
      // Also allow walking to own seat tile (blocked for others but not self)
      const key = this.ownSeatKey(ch);
      if (!key || key !== `${col},${row}`) return false;
    }
    const path = this.withOwnSeatUnblocked(ch, () =>
      findPath(ch.tileCol, ch.tileRow, col, row, this.tileMap, this.blockedTiles),
    );
    if (path.length === 0) return false;
    ch.path = path;
    ch.moveProgress = 0;
    ch.state = CharacterState.WALK;
    ch.frame = 0;
    ch.frameTimer = 0;
    return true;
  }

  /** Create a sub-agent character with the parent's palette. Returns the sub-agent ID. */
  addSubagent(parentAgentId: number, parentToolId: string): number {
    const key = `${parentAgentId}:${parentToolId}`;
    if (this.subagentIdMap.has(key)) return this.subagentIdMap.get(key)!;

    const id = this.nextSubagentId--;
    const parentCh = this.characters.get(parentAgentId);
    const palette = parentCh ? parentCh.palette : 0;
    const hueShift = parentCh ? parentCh.hueShift : 0;

    // Find the closest walkable tile to the parent, avoiding tiles occupied by other characters
    const parentCol = parentCh ? parentCh.tileCol : 0;
    const parentRow = parentCh ? parentCh.tileRow : 0;
    const dist = (c: number, r: number) => Math.abs(c - parentCol) + Math.abs(r - parentRow);

    // Build set of tiles occupied by existing characters
    const occupiedTiles = new Set<string>();
    for (const [, other] of this.characters) {
      occupiedTiles.add(`${other.tileCol},${other.tileRow}`);
    }

    let spawn = { col: parentCol, row: parentRow };
    if (this.walkableTiles.length > 0) {
      let closest = this.walkableTiles[0];
      let closestDist = Infinity;
      for (const tile of this.walkableTiles) {
        if (occupiedTiles.has(`${tile.col},${tile.row}`)) continue;
        const d = dist(tile.col, tile.row);
        if (d < closestDist) {
          closest = tile;
          closestDist = d;
        }
      }
      spawn = closest;
    }

    const ch = createCharacter(id, palette, null, null, hueShift);
    ch.x = spawn.col * TILE_SIZE + TILE_SIZE / 2;
    ch.y = spawn.row * TILE_SIZE + TILE_SIZE / 2;
    ch.tileCol = spawn.col;
    ch.tileRow = spawn.row;
    // Face the same direction as the parent agent
    if (parentCh) ch.dir = parentCh.dir;
    ch.isSubagent = true;
    ch.parentAgentId = parentAgentId;
    ch.matrixEffect = 'spawn';
    ch.matrixEffectTimer = 0;
    ch.matrixEffectSeeds = matrixEffectSeeds();
    this.characters.set(id, ch);

    this.subagentIdMap.set(key, id);
    this.subagentMeta.set(id, { parentAgentId, parentToolId });
    return id;
  }

  /** Remove a specific sub-agent character and free its seat */
  removeSubagent(parentAgentId: number, parentToolId: string): void {
    const key = `${parentAgentId}:${parentToolId}`;
    const id = this.subagentIdMap.get(key);
    if (id === undefined) return;

    const ch = this.characters.get(id);
    if (ch) {
      if (ch.matrixEffect === 'despawn') {
        // Already despawning — just clean up maps
        this.subagentIdMap.delete(key);
        this.subagentMeta.delete(id);
        return;
      }
      if (ch.seatId) {
        const seat = this.seats.get(ch.seatId);
        if (seat) seat.assigned = false;
      }
      // Start despawn animation — keep character in map for rendering
      ch.matrixEffect = 'despawn';
      ch.matrixEffectTimer = 0;
      ch.matrixEffectSeeds = matrixEffectSeeds();
      ch.bubbleType = null;
    }
    // Clean up tracking maps immediately so keys don't collide
    this.subagentIdMap.delete(key);
    this.subagentMeta.delete(id);
    if (this.selectedAgentId === id) this.selectedAgentId = null;
    this.promoteQueueHead();
  }

  /** Remove all sub-agents belonging to a parent agent */
  removeAllSubagents(parentAgentId: number): void {
    const toRemove: string[] = [];
    for (const [key, id] of this.subagentIdMap) {
      const meta = this.subagentMeta.get(id);
      if (meta && meta.parentAgentId === parentAgentId) {
        const ch = this.characters.get(id);
        if (ch) {
          if (ch.matrixEffect === 'despawn') {
            // Already despawning — just clean up maps
            this.subagentMeta.delete(id);
            toRemove.push(key);
            continue;
          }
          if (ch.seatId) {
            const seat = this.seats.get(ch.seatId);
            if (seat) seat.assigned = false;
          }
          // Start despawn animation
          ch.matrixEffect = 'despawn';
          ch.matrixEffectTimer = 0;
          ch.matrixEffectSeeds = matrixEffectSeeds();
          ch.bubbleType = null;
        }
        this.subagentMeta.delete(id);
        if (this.selectedAgentId === id) this.selectedAgentId = null;
        toRemove.push(key);
      }
    }
    for (const key of toRemove) {
      this.subagentIdMap.delete(key);
    }
    if (toRemove.length > 0) this.promoteQueueHead();
  }

  /** Look up the sub-agent character ID for a given parent+toolId, or null */
  getSubagentId(parentAgentId: number, parentToolId: string): number | null {
    return this.subagentIdMap.get(`${parentAgentId}:${parentToolId}`) ?? null;
  }

  setAgentActive(id: number, active: boolean): void {
    const ch = this.characters.get(id);
    if (ch) {
      ch.isActive = active;
      if (!active) {
        // Sentinel -1: signals turn just ended, skip next seat rest timer.
        // Prevents the WALK handler from setting a 2-4 min rest on arrival.
        ch.seatTimer = -1;
        ch.path = [];
        ch.moveProgress = 0;
      }
      this.rebuildFurnitureInstances();
    }
  }

  /** Rebuild furniture instances with auto-state applied (active agents turn electronics ON) */
  private rebuildFurnitureInstances(): void {
    // Collect tiles where active agents face desks
    const autoOnTiles = new Set<string>();
    for (const ch of this.characters.values()) {
      if (!ch.isActive || !ch.seatId) continue;
      const seat = this.seats.get(ch.seatId);
      if (!seat) continue;
      // Find the desk tile(s) the agent faces from their seat
      const dCol =
        seat.facingDir === Direction.RIGHT ? 1 : seat.facingDir === Direction.LEFT ? -1 : 0;
      const dRow = seat.facingDir === Direction.DOWN ? 1 : seat.facingDir === Direction.UP ? -1 : 0;
      // Check tiles in the facing direction (desk could be 1-3 tiles deep)
      for (let d = 1; d <= AUTO_ON_FACING_DEPTH; d++) {
        const tileCol = seat.seatCol + dCol * d;
        const tileRow = seat.seatRow + dRow * d;
        autoOnTiles.add(`${tileCol},${tileRow}`);
      }
      // Also check tiles to the sides of the facing direction (desks can be wide)
      for (let d = 1; d <= AUTO_ON_SIDE_DEPTH; d++) {
        const baseCol = seat.seatCol + dCol * d;
        const baseRow = seat.seatRow + dRow * d;
        if (dCol !== 0) {
          // Facing left/right: check tiles above and below
          autoOnTiles.add(`${baseCol},${baseRow - 1}`);
          autoOnTiles.add(`${baseCol},${baseRow + 1}`);
        } else {
          // Facing up/down: check tiles left and right
          autoOnTiles.add(`${baseCol - 1},${baseRow}`);
          autoOnTiles.add(`${baseCol + 1},${baseRow}`);
        }
      }
    }

    if (autoOnTiles.size === 0) {
      this.furniture = layoutToFurnitureInstances(this.layout.furniture);
      return;
    }

    // Build modified furniture list with auto-state and animation applied
    const animFrame = Math.floor(this.furnitureAnimTimer / FURNITURE_ANIM_INTERVAL_SEC);
    const modifiedFurniture: PlacedFurniture[] = this.layout.furniture.map((item) => {
      const entry = getCatalogEntry(item.type);
      if (!entry) return item;
      // Check if any tile of this furniture overlaps an auto-on tile
      for (let dr = 0; dr < entry.footprintH; dr++) {
        for (let dc = 0; dc < entry.footprintW; dc++) {
          if (autoOnTiles.has(`${item.col + dc},${item.row + dr}`)) {
            let onType = getOnStateType(item.type);
            if (onType !== item.type) {
              // Check if the on-state type has animation frames
              const frames = getAnimationFrames(onType);
              if (frames && frames.length > 1) {
                const frameIdx = animFrame % frames.length;
                onType = frames[frameIdx];
              }
              return { ...item, type: onType };
            }
            return item;
          }
        }
      }
      return item;
    });

    this.furniture = layoutToFurnitureInstances(modifiedFurniture);
  }

  setAgentTool(id: number, tool: string | null): void {
    const ch = this.characters.get(id);
    if (ch) {
      ch.currentTool = tool;
    }
  }

  setAgentSource(id: number, source: string | null | undefined): void {
    if (!source) return;
    const ch = this.characters.get(id);
    if (ch) {
      ch.source = source;
    }
  }

  /** Attach CLI-level identity to a character: folder (basename of cwd) and a
   *  4-char session suffix. Both are optional — when a CLI doesn't provide
   *  cwd (rare) we just skip folder. Called from the event dispatcher on
   *  session_start and defensively on every event (idempotent). */
  setAgentIdentity(
    id: number,
    cwd: string | null | undefined,
    sessionId: string | null | undefined,
  ): void {
    const ch = this.characters.get(id);
    if (!ch) return;
    if (cwd) {
      // Accept both posix and windows separators. Trailing slashes are
      // trimmed so `/Users/me/proj/` still gives "proj", not "".
      const trimmed = cwd.replace(/[/\\]+$/, '');
      const parts = trimmed.split(/[/\\]/);
      const folder = parts[parts.length - 1];
      if (folder) ch.folderName = folder;
    }
    if (sessionId && !ch.sessionShortId) {
      // Strip dashes first so the 4 hex chars are contiguous and not a
      // formatting artefact. Then slice from [20, 24) — past the UUIDv7
      // timestamp prefix (first 48 bits / 12 hex chars) and past the
      // version + variant nibbles. Two Codex sessions started in the
      // same millisecond share "019da930…" at the head but diverge
      // deep in the random tail. For UUIDv4 (Claude) every position is
      // random so this still works. Falls back to the head / tail when
      // the id is unexpectedly short.
      const hex = sessionId.replace(/-/g, '');
      ch.sessionShortId =
        hex.length >= 24 ? hex.slice(20, 24) : hex.length >= 4 ? hex.slice(-4) : hex;
    }
  }

  showPermissionBubble(id: number): void {
    const ch = this.characters.get(id);
    if (ch) {
      ch.bubbleType = 'permission';
      ch.bubbleTimer = 0;
    }
  }

  clearPermissionBubble(id: number): void {
    const ch = this.characters.get(id);
    if (ch && ch.bubbleType === 'permission') {
      ch.bubbleType = null;
      ch.bubbleTimer = 0;
    }
  }

  clearBubble(id: number): void {
    const ch = this.characters.get(id);
    if (ch) {
      ch.bubbleType = null;
      ch.bubbleTimer = 0;
    }
  }

  showWaitingBubble(id: number): void {
    const ch = this.characters.get(id);
    if (ch) {
      ch.bubbleType = 'waiting';
      ch.bubbleTimer = WAITING_BUBBLE_DURATION_SEC;
    }
  }

  /** Dismiss bubble on click — permission: instant, waiting: quick fade */
  dismissBubble(id: number): void {
    const ch = this.characters.get(id);
    if (!ch || !ch.bubbleType) return;
    if (ch.bubbleType === 'permission') {
      ch.bubbleType = null;
      ch.bubbleTimer = 0;
    } else if (ch.bubbleType === 'waiting') {
      // Trigger immediate fade (0.3s remaining)
      ch.bubbleTimer = Math.min(ch.bubbleTimer, DISMISS_BUBBLE_FAST_FADE_SEC);
    }
  }

  setTeamInfo(
    id: number,
    teamName?: string,
    agentName?: string,
    isTeamLead?: boolean,
    leadAgentId?: number,
    teamUsesTmux?: boolean,
  ): void {
    const ch = this.characters.get(id);
    if (!ch) return;
    ch.teamName = teamName;
    ch.agentName = agentName;
    ch.isTeamLead = isTeamLead;
    ch.leadAgentId = leadAgentId;
    if (teamUsesTmux !== undefined) {
      ch.teamUsesTmux = teamUsesTmux;
    }
  }

  setAgentTokens(id: number, inputTokens: number, outputTokens: number): void {
    const ch = this.characters.get(id);
    if (!ch) return;
    ch.inputTokens = inputTokens;
    ch.outputTokens = outputTokens;
  }

  update(dt: number): void {
    // Furniture animation cycling
    const prevFrame = Math.floor(this.furnitureAnimTimer / FURNITURE_ANIM_INTERVAL_SEC);
    this.furnitureAnimTimer += dt;
    const newFrame = Math.floor(this.furnitureAnimTimer / FURNITURE_ANIM_INTERVAL_SEC);
    if (newFrame !== prevFrame) {
      this.rebuildFurnitureInstances();
    }

    const toDelete: number[] = [];
    for (const ch of this.characters.values()) {
      // Handle matrix effect animation
      if (ch.matrixEffect) {
        ch.matrixEffectTimer += dt;
        if (ch.matrixEffectTimer >= MATRIX_EFFECT_DURATION) {
          if (ch.matrixEffect === 'spawn') {
            // Spawn complete — clear effect, resume normal FSM
            ch.matrixEffect = null;
            ch.matrixEffectTimer = 0;
            ch.matrixEffectSeeds = [];
          } else {
            // Despawn complete — mark for deletion
            toDelete.push(ch.id);
          }
        }
        continue; // skip normal FSM while effect is active
      }

      // Temporarily unblock own seat so character can pathfind to it.
      // Pass the live character map so WALK can stall on inter-agent
      // collisions (A* only plans around furniture, not other walkers).
      this.withOwnSeatUnblocked(ch, () =>
        updateCharacter(
          ch,
          dt,
          this.walkableTiles,
          this.seats,
          this.tileMap,
          this.blockedTiles,
          this.characters.values(),
        ),
      );

      // Drive ambient-visit timers (whiteboard / lounge / cooler / clock).
      // Runs after updateCharacter so arrival transitions (WALK→TYPE) land
      // before we decide to linger / return.
      this.tickAmbientBehaviors(ch, dt);

      // Tick bubble timer for waiting bubbles. Queued overflow agents keep
      // the bubble persistent — re-assert instead of counting down.
      if (this.waitingQueue.includes(ch.id)) {
        if (ch.bubbleType !== 'waiting') {
          ch.bubbleType = 'waiting';
        }
        ch.bubbleTimer = BUBBLE_FADE_DURATION_SEC + 1; // above fade threshold
      } else if (ch.bubbleType === 'waiting') {
        ch.bubbleTimer -= dt;
        if (ch.bubbleTimer <= 0) {
          ch.bubbleType = null;
          ch.bubbleTimer = 0;
        }
      }
    }
    // Remove characters that finished despawn
    for (const id of toDelete) {
      this.characters.delete(id);
    }
  }

  getCharacters(): Character[] {
    return Array.from(this.characters.values());
  }

  /** Get character at pixel position (for hit testing). Returns id or null. */
  getCharacterAt(worldX: number, worldY: number): number | null {
    const chars = this.getCharacters().sort((a, b) => b.y - a.y);
    for (const ch of chars) {
      // Skip characters that are despawning
      if (ch.matrixEffect === 'despawn') continue;
      // Character sprite is 16x24, anchored bottom-center
      // Apply sitting offset to match visual position
      let sittingOffset = ch.state === CharacterState.TYPE ? CHARACTER_SITTING_OFFSET_PX : 0;
      if (sittingOffset > 0) {
        const seatId = ch.tempSeatId ?? ch.seatId;
        const extra = seatId ? this.seats.get(seatId)?.renderYOffsetPx : undefined;
        if (extra) sittingOffset += extra;
      }
      const anchorY = ch.y + sittingOffset;
      const left = ch.x - CHARACTER_HIT_HALF_WIDTH;
      const right = ch.x + CHARACTER_HIT_HALF_WIDTH;
      const top = anchorY - CHARACTER_HIT_HEIGHT;
      const bottom = anchorY;
      if (worldX >= left && worldX <= right && worldY >= top && worldY <= bottom) {
        return ch.id;
      }
    }
    return null;
  }
}
