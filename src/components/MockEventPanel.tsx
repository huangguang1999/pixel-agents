import { useEffect, useState } from 'react';

import { LIBRARY_TOOLS } from '../hooks/agentEventDispatch.js';
import { useI18n } from '../i18n/useI18n.js';
import type { Strings } from '../i18n/strings.js';
import { agentDisplayLabel } from '../office/engine/agentLabel.js';
import type { OfficeState } from '../office/engine/officeState.js';
import { AgentLogPanel } from './AgentLogPanel.js';

interface Props {
  officeState: OfficeState;
}

type WalkKey =
  | 'targetDoor'
  | 'targetWhiteboard'
  | 'targetBookshelfL'
  | 'targetBookshelfR'
  | 'targetWaterCooler'
  | 'targetPantryCoffee'
  | 'targetSofaCoffee'
  | 'targetMeeting'
  | 'targetBin';

type TargetPick = 'leftmost' | 'rightmost' | 'topmost' | 'bottommost';

/** Walk-to-X button spec: resolved at click time from the live layout so
 * moving a piece of furniture in the JSON automatically updates the walk
 * destination. `fallback` is used only when no matching furniture exists. */
interface WalkSpec {
  type: string;
  /** Disambiguator when multiple instances of `type` exist in the layout */
  pick?: TargetPick;
  /** Offset from the furniture's anchor to the stand-in tile */
  offset: { dx: number; dy: number };
  fallback: { col: number; row: number };
}

const WALK_SPEC: Record<WalkKey, WalkSpec> = {
  targetDoor:         { type: 'DOOR',              offset: { dx:  0, dy:  2 }, fallback: { col: 14, row: 11 } },
  targetWhiteboard:   { type: 'WHITEBOARD',        offset: { dx:  0, dy:  2 }, fallback: { col:  5, row: 11 } },
  targetBookshelfL:   { type: 'DOUBLE_BOOKSHELF', pick: 'leftmost',  offset: { dx: -1, dy:  2 }, fallback: { col:  1, row: 11 } },
  targetBookshelfR:   { type: 'DOUBLE_BOOKSHELF', pick: 'rightmost', offset: { dx:  2, dy:  2 }, fallback: { col:  9, row: 11 } },
  targetWaterCooler:  { type: 'WATER_COOLER',      offset: { dx:  0, dy: -1 }, fallback: { col:  1, row: 15 } },
  targetPantryCoffee: { type: 'COFFEE',           pick: 'leftmost',  offset: { dx:  1, dy: -1 }, fallback: { col:  2, row: 18 } },
  targetSofaCoffee:   { type: 'COFFEE_TABLE',      offset: { dx: -2, dy:  0 }, fallback: { col: 12, row: 14 } },
  targetMeeting:      { type: 'TABLE_FRONT',       offset: { dx:  0, dy: -1 }, fallback: { col:  4, row: 15 } },
  targetBin:          { type: 'BIN',               offset: { dx:  1, dy:  0 }, fallback: { col:  3, row: 20 } },
};

function resolveWalkTarget(
  key: WalkKey,
  officeState: OfficeState,
): { col: number; row: number } {
  const spec = WALK_SPEC[key];
  const matches = officeState.getLayout().furniture.filter((f) => f.type === spec.type);
  if (matches.length === 0) return spec.fallback;
  let picked = matches[0];
  switch (spec.pick) {
    case 'leftmost':
      picked = matches.reduce((a, b) => (a.col <= b.col ? a : b));
      break;
    case 'rightmost':
      picked = matches.reduce((a, b) => (a.col >= b.col ? a : b));
      break;
    case 'topmost':
      picked = matches.reduce((a, b) => (a.row <= b.row ? a : b));
      break;
    case 'bottommost':
      picked = matches.reduce((a, b) => (a.row >= b.row ? a : b));
      break;
  }
  return { col: picked.col + spec.offset.dx, row: picked.row + spec.offset.dy };
}

const TOOL_BUTTONS = ['Edit', 'Write', 'Bash', 'Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch'] as const;

export function MockEventPanel({ officeState }: Props) {
  const { t } = useI18n();
  const [, setTick] = useState(0);
  const [open, setOpen] = useState(true);
  const [logAgentId, setLogAgentId] = useState<number | null>(null);

  useEffect(() => {
    const id = setInterval(() => setTick((v) => v + 1), 400);
    return () => clearInterval(id);
  }, []);

  const agents = Array.from(officeState.characters.values()).filter((c) => !c.isSubagent);

  const addAgent = (): void => {
    let nextId = 1;
    while (officeState.characters.has(nextId)) nextId++;
    officeState.addAgent(nextId);
    setTick((v) => v + 1);
  };

  const removeAgent = (id: number): void => {
    officeState.removeAgent(id);
    setTick((v) => v + 1);
  };

  const work = (id: number, tool: string): void => {
    officeState.setAgentActive(id, true);
    officeState.setAgentTool(id, tool);
    if (LIBRARY_TOOLS.has(tool)) {
      officeState.sendToLibrary(id);
    } else {
      officeState.sendToSeat(id);
    }
    setTick((v) => v + 1);
  };

  const notify = (id: number): void => {
    officeState.showPermissionBubble(id);
    setTick((v) => v + 1);
  };
  const waiting = (id: number): void => {
    officeState.showWaitingBubble(id);
    setTick((v) => v + 1);
  };
  const idle = (id: number): void => {
    officeState.setAgentActive(id, false);
    officeState.setAgentTool(id, null);
    setTick((v) => v + 1);
  };

  const walkTo = (id: number, key: WalkKey): void => {
    officeState.setAgentActive(id, false);
    officeState.setAgentTool(id, null);
    // Lounge button: try to take a free sofa/bench seat so the agent sits
    if (key === 'targetSofaCoffee' && officeState.sendToLounge(id)) {
      setTick((v) => v + 1);
      return;
    }
    const target = resolveWalkTarget(key, officeState);
    officeState.walkToTile(id, target.col, target.row);
    setTick((v) => v + 1);
  };

  const logPanel =
    logAgentId !== null && officeState.characters.has(logAgentId) ? (
      <AgentLogPanel
        officeState={officeState}
        agentId={logAgentId}
        onClose={() => setLogAgentId(null)}
      />
    ) : null;

  if (!open) {
    return (
      <>
        <button
          type="button"
          onClick={() => setOpen(true)}
          style={collapsedBtn}
          title={t.panelTitle}
          aria-label={t.panelTitle}
        >
          🎛
        </button>
        {logPanel}
      </>
    );
  }

  return (
    <>
    <div style={panelWrap}>
      <div style={panelHeader}>
        <span>
          {t.panelTitle} · {t.panelAgents(agents.length)}
        </span>
        <div style={{ display: 'flex', gap: 6 }}>
          <button type="button" onClick={addAgent} style={panelBtn}>
            {t.panelAdd}
          </button>
          <button type="button" onClick={() => setOpen(false)} style={panelBtn}>
            ▼
          </button>
        </div>
      </div>
      {agents.length === 0 && <div style={panelEmpty}>{t.panelEmpty}</div>}
      <div style={panelBody}>
        {agents.map((ch) => (
          <div key={ch.id} style={agentRow}>
            <div style={agentHeader}>
              <span style={agentIdBadge}>#{ch.id}</span>
              {ch.folderName && (
                <span style={agentFolderLabel} title={`session ${ch.sessionShortId ?? '—'}`}>
                  {agentDisplayLabel(ch, agents)}
                </span>
              )}
              <span style={agentMeta}>{formatState(ch, t)}</span>
              <button
                type="button"
                onClick={() => setLogAgentId(ch.id === logAgentId ? null : ch.id)}
                style={ch.id === logAgentId ? logBtnActive : logBtn}
              >
                {t.panelLog}
              </button>
              <button type="button" onClick={() => removeAgent(ch.id)} style={rmBtn}>
                ✕
              </button>
            </div>
            <div style={btnRow}>
              {TOOL_BUTTONS.map((tool) => (
                <button
                  key={tool}
                  type="button"
                  onClick={() => work(ch.id, tool)}
                  style={smBtn}
                >
                  {tool}
                </button>
              ))}
            </div>
            <div style={btnRow}>
              <button type="button" onClick={() => notify(ch.id)} style={smBtn}>
                {t.panelNotify}
              </button>
              <button type="button" onClick={() => waiting(ch.id)} style={smBtn}>
                {t.panelWaiting}
              </button>
              <button type="button" onClick={() => idle(ch.id)} style={smBtn}>
                {t.panelIdle}
              </button>
              {(Object.keys(WALK_SPEC) as WalkKey[]).map((key) => (
                <button key={key} type="button" onClick={() => walkTo(ch.id, key)} style={smBtn}>
                  {t.panelWalkPrefix}
                  {t[key]}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
    {logPanel}
    </>
  );
}

function formatState(
  ch: { state: string; isActive: boolean; currentTool: string | null; bubbleType: string | null },
  t: Strings,
): string {
  const parts: string[] = [];
  if (ch.currentTool) parts.push(ch.currentTool);
  parts.push(ch.isActive ? t.stateActive : t.stateIdle);
  if (ch.bubbleType === 'permission') parts.push(t.bubblePermission);
  else if (ch.bubbleType === 'waiting') parts.push(t.bubbleWaiting);
  return parts.join(' · ');
}

const panelWrap: React.CSSProperties = {
  position: 'absolute',
  left: 12,
  bottom: 12,
  width: 520,
  maxHeight: '60vh',
  background: 'rgba(20, 12, 32, 0.92)',
  border: '1px solid #3a2a55',
  borderRadius: 8,
  color: '#d0cce0',
  fontSize: 11,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
  boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
  zIndex: 1000,
};

const panelHeader: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  padding: '6px 10px',
  background: 'rgba(60, 40, 90, 0.5)',
  borderBottom: '1px solid #3a2a55',
  fontWeight: 600,
};

const panelBody: React.CSSProperties = {
  overflowY: 'auto',
  padding: 6,
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
};

const panelEmpty: React.CSSProperties = {
  padding: 10,
  color: '#7d7695',
  textAlign: 'center',
};

const agentRow: React.CSSProperties = {
  padding: '6px 8px',
  background: 'rgba(40, 28, 60, 0.6)',
  borderRadius: 6,
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
};

const agentHeader: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
};

const agentIdBadge: React.CSSProperties = {
  background: '#4a3570',
  padding: '2px 6px',
  borderRadius: 4,
  fontWeight: 600,
};

const agentFolderLabel: React.CSSProperties = {
  background: '#2a3f4a',
  padding: '2px 6px',
  borderRadius: 4,
  color: '#bdd4e0',
  fontWeight: 500,
  maxWidth: 220,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const agentMeta: React.CSSProperties = {
  flex: 1,
  color: '#9e98b5',
  fontSize: 10,
};

const rmBtn: React.CSSProperties = {
  background: '#552030',
  color: '#f0cfd6',
  border: 'none',
  borderRadius: 4,
  padding: '2px 6px',
  cursor: 'pointer',
  fontSize: 10,
};

const logBtn: React.CSSProperties = {
  background: '#2d2042',
  color: '#cfc9e0',
  border: '1px solid #4a3570',
  borderRadius: 4,
  padding: '2px 6px',
  cursor: 'pointer',
  fontSize: 10,
  fontFamily: 'inherit',
};

const logBtnActive: React.CSSProperties = {
  ...logBtn,
  background: '#4a3570',
  color: '#fff',
};

const btnRow: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 4,
};

const smBtn: React.CSSProperties = {
  background: '#2d2042',
  color: '#cfc9e0',
  border: '1px solid #4a3570',
  borderRadius: 4,
  padding: '3px 7px',
  cursor: 'pointer',
  fontSize: 10,
  fontFamily: 'inherit',
};

const panelBtn: React.CSSProperties = {
  ...smBtn,
  padding: '4px 10px',
};

const collapsedBtn: React.CSSProperties = {
  // Slot 2 of the right-side icon stack (Legend → MockEventPanel).
  position: 'absolute',
  right: 2,
  top: 42,
  width: 28,
  height: 28,
  background: 'transparent',
  color: '#cfc9e0',
  border: 'none',
  padding: 0,
  cursor: 'pointer',
  fontSize: 18,
  lineHeight: 1,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 1000,
  opacity: 0.75,
};
