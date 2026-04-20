import { useState } from 'react';

import { useI18n } from '../i18n/useI18n.js';

export function Legend() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        style={collapsedBtn}
        title={t.legendOpen}
        aria-label={t.legendOpen}
      >
        📖
      </button>
    );
  }

  return (
    <div style={wrap}>
      <div style={header}>
        <span>{t.legendTitle}</span>
        <button type="button" onClick={() => setOpen(false)} style={closeBtn}>
          {t.legendClose} ▼
        </button>
      </div>
      <div style={tableWrap}>
        <table style={table}>
          <thead>
            <tr>
              <th style={th}>{t.legendHookCol}</th>
              <th style={th}>{t.legendActionCol}</th>
              <th style={th}>{t.legendFurnitureCol}</th>
            </tr>
          </thead>
          <tbody>
            {t.legendRows.map((row, i) => (
              <tr key={i} style={i % 2 === 0 ? trOdd : trEven}>
                <td style={tdHook}>{row.hook}</td>
                <td style={td}>{row.action}</td>
                <td style={tdMuted}>{row.furniture}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const wrap: React.CSSProperties = {
  position: 'absolute',
  right: 12,
  bottom: 12,
  width: 480,
  maxHeight: '70vh',
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

const header: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  padding: '8px 12px',
  background: 'rgba(60, 40, 90, 0.55)',
  borderBottom: '1px solid #3a2a55',
  fontWeight: 600,
};

const closeBtn: React.CSSProperties = {
  background: 'transparent',
  color: '#cfc9e0',
  border: '1px solid #4a3570',
  borderRadius: 4,
  padding: '2px 8px',
  cursor: 'pointer',
  fontSize: 10,
  fontFamily: 'inherit',
};

const tableWrap: React.CSSProperties = {
  overflowY: 'auto',
};

const table: React.CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
};

const th: React.CSSProperties = {
  textAlign: 'left',
  padding: '6px 10px',
  color: '#9e98b5',
  fontSize: 10,
  fontWeight: 600,
  borderBottom: '1px solid #3a2a55',
  textTransform: 'uppercase',
  letterSpacing: 0.5,
};

const trOdd: React.CSSProperties = {
  background: 'rgba(40, 28, 60, 0.3)',
};

const trEven: React.CSSProperties = {
  background: 'transparent',
};

const td: React.CSSProperties = {
  padding: '5px 10px',
  verticalAlign: 'top',
  lineHeight: 1.4,
};

const tdHook: React.CSSProperties = {
  ...td,
  color: '#c7b4e8',
  whiteSpace: 'nowrap',
};

const tdMuted: React.CSSProperties = {
  ...td,
  color: '#7d7695',
  fontSize: 10,
};

const collapsedBtn: React.CSSProperties = {
  // Slot 1 of the right-side icon stack (Legend → MockEventPanel). Language
  // switching lives in the native menu bar now, so the icon stack starts here.
  position: 'absolute',
  right: 2,
  top: 10,
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
