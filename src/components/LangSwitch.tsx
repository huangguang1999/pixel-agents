import { useI18n } from '../i18n/useI18n.js';

export function LangSwitch() {
  const { lang, setLang } = useI18n();
  return (
    <div style={wrap}>
      <button
        type="button"
        onClick={() => setLang('zh')}
        style={{ ...btn, ...(lang === 'zh' ? btnActive : {}) }}
      >
        中
      </button>
      <button
        type="button"
        onClick={() => setLang('en')}
        style={{ ...btn, ...(lang === 'en' ? btnActive : {}) }}
      >
        EN
      </button>
    </div>
  );
}

const wrap: React.CSSProperties = {
  // Slot 1 of the right-side icon stack. No background; matches the
  // Legend / MockEventPanel icons below.
  position: 'absolute',
  top: 10,
  right: 2,
  display: 'flex',
  gap: 2,
  padding: 0,
  zIndex: 1000,
};

const btn: React.CSSProperties = {
  background: 'transparent',
  color: '#7d7695',
  border: 'none',
  padding: '2px 5px',
  borderRadius: 3,
  cursor: 'pointer',
  fontSize: 11,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontWeight: 600,
  lineHeight: 1,
};

const btnActive: React.CSSProperties = {
  color: '#d0cce0',
};
