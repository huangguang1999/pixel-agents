import { useEffect, useRef, useState } from 'react';

import { useI18n } from '../i18n/useI18n.js';
import type { AgentLogEntry } from '../office/engine/officeState.js';
import type { OfficeState } from '../office/engine/officeState.js';

interface Props {
  officeState: OfficeState;
  agentId: number;
  onClose: () => void;
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number): string => n.toString().padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Compress consecutive identical (kind,tool) entries into "kind tool ×N". */
function collapse(entries: AgentLogEntry[]): Array<AgentLogEntry & { count: number }> {
  const out: Array<AgentLogEntry & { count: number }> = [];
  for (const e of entries) {
    const last = out[out.length - 1];
    if (last && last.kind === e.kind && last.tool === e.tool && last.detail === e.detail) {
      last.count++;
      last.ts = e.ts; // use most-recent ts for display
    } else {
      out.push({ ...e, count: 1 });
    }
  }
  return out;
}

export function AgentLogPanel({ officeState, agentId, onClose }: Props) {
  const { t } = useI18n();
  const [, setTick] = useState(0);
  const bodyRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);

  useEffect(() => {
    const id = setInterval(() => setTick((v) => v + 1), 400);
    return () => clearInterval(id);
  }, []);

  const raw = officeState.agentLogs.get(agentId) ?? [];
  const entries = collapse(raw);

  useEffect(() => {
    if (stickToBottomRef.current && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  });

  const onScroll = (): void => {
    const el = bodyRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
    stickToBottomRef.current = atBottom;
  };

  return (
    <div style={panelWrap}>
      <div style={panelHeader}>
        <span>
          {t.logPanelTitle} · #{agentId}
        </span>
        <button type="button" onClick={onClose} style={closeBtn}>
          ✕
        </button>
      </div>
      {entries.length === 0 ? (
        <div style={panelEmpty}>{t.logPanelEmpty}</div>
      ) : (
        <div ref={bodyRef} onScroll={onScroll} style={panelBody}>
          {entries.map((e, i) => (
            <div key={i} style={logRow}>
              <span style={logTime}>{fmtTime(e.ts)}</span>
              <span style={logKind(e.kind)}>{e.kind}</span>
              {e.tool && <span style={logTool}>{e.tool}</span>}
              {e.detail && <span style={logDetail}>{e.detail}</span>}
              {e.count > 1 && <span style={logCount}>×{e.count}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function logKind(kind: string): React.CSSProperties {
  const colorMap: Record<string, string> = {
    session_start: '#7dd3a0',
    session_end: '#c9a0a0',
    pre_tool_use: '#9fb5e8',
    post_tool_use: '#6a7fa8',
    notification: '#e8c17d',
    stop: '#c9a0a0',
  };
  return {
    color: colorMap[kind] ?? '#9e98b5',
    minWidth: 92,
  };
}

const panelWrap: React.CSSProperties = {
  position: 'absolute',
  right: 12,
  bottom: 12,
  width: 380,
  maxHeight: '60vh',
  background: '#140c20',
  border: '1px solid #3a2a55',
  borderRadius: 8,
  color: '#d0cce0',
  fontSize: 11,
  lineHeight: 1.5,
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
  overflowX: 'hidden',
  padding: 6,
  display: 'flex',
  flexDirection: 'column',
  gap: 3,
};

const panelEmpty: React.CSSProperties = {
  padding: 14,
  color: '#7d7695',
  textAlign: 'center',
};

const logRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  gap: 8,
  padding: '1px 6px',
  borderRadius: 3,
  whiteSpace: 'nowrap',
  minWidth: 0,
};

const logTime: React.CSSProperties = {
  color: '#6a628a',
  flex: '0 0 auto',
  minWidth: 56,
};

const logTool: React.CSSProperties = {
  color: '#cfc9e0',
  flex: '0 0 auto',
};

const logDetail: React.CSSProperties = {
  color: '#7d7695',
  flex: '1 1 auto',
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

const logCount: React.CSSProperties = {
  marginLeft: 'auto',
  color: '#6a628a',
  flex: '0 0 auto',
};

const closeBtn: React.CSSProperties = {
  background: '#2d2042',
  color: '#cfc9e0',
  border: '1px solid #4a3570',
  borderRadius: 4,
  padding: '2px 8px',
  cursor: 'pointer',
  fontSize: 11,
  fontFamily: 'inherit',
};
