import { useCallback, useEffect, useRef, useState } from "react";

import { LangSwitch } from "./components/LangSwitch.js";
import { Legend } from "./components/Legend.js";
import { MockEventPanel } from "./components/MockEventPanel.js";
import { OfficeCanvas } from "./office/components/OfficeCanvas.js";
import { EditorState } from "./office/editor/editorState.js";
import { OfficeState } from "./office/engine/officeState.js";
import { useExtensionMessages } from "./hooks/useExtensionMessages.js";
import { useTauriAgentEvents } from "./hooks/useTauriAgentEvents.js";
import { useTauriMenuLang } from "./hooks/useTauriMenuLang.js";
import { isBrowserRuntime, isTauriRuntime } from "./runtime.js";

// Game state lives outside React — updated imperatively by message handlers.
// Parked on window so it survives Vite HMR: when App.tsx re-evaluates after a
// hot update, module-level refs reset, but window.__PA_OFFICE_STATE__ persists.
const officeStateRef = { current: null as OfficeState | null };
const editorState = new EditorState();

function getOfficeState(): OfficeState {
  if (!officeStateRef.current && typeof window !== 'undefined') {
    const prior = (window as unknown as { __PA_OFFICE_STATE__?: OfficeState })
      .__PA_OFFICE_STATE__;
    // Guard against a stale OfficeState saved during a bad partial-HMR cycle
    // (empty furniture + empty seats = the default `new OfficeState()` shape
    // with no layout rebuilt). Reading it back would leave the app stuck on a
    // blank room forever; a full reload re-runs initBrowserMock cleanly.
    // Gated by a session flag to prevent loops if assets genuinely never load.
    const isStale =
      isBrowserRuntime && prior && prior.furniture.length === 0 && prior.seats.size === 0;
    if (isStale && !sessionStorage.getItem('pa-hmr-recover')) {
      sessionStorage.setItem('pa-hmr-recover', '1');
      window.location.reload();
    }
    officeStateRef.current = prior ?? null;
  }
  if (!officeStateRef.current) {
    officeStateRef.current = new OfficeState();
    if (typeof window !== 'undefined') {
      (window as unknown as { __PA_OFFICE_STATE__: OfficeState }).__PA_OFFICE_STATE__ =
        officeStateRef.current;
      sessionStorage.removeItem('pa-hmr-recover');
    }
  }
  return officeStateRef.current;
}

function noop(): void {}

export default function App() {
  useEffect(() => {
    if (isBrowserRuntime) {
      void import("./browserMock.js").then(({ dispatchMockMessages }) =>
        dispatchMockMessages(),
      );
    }
  }, []);

  const { layoutReady } = useExtensionMessages(getOfficeState);
  useTauriAgentEvents(getOfficeState);
  useTauriMenuLang();

  const [zoom, setZoom] = useState(2);
  const panRef = useRef({ x: 0, y: 0 });

  const handleClick = useCallback((_agentId: number) => {}, []);
  const handleZoomChange = useCallback((z: number) => setZoom(z), []);

  if (!layoutReady) {
    return (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 14,
          color: "#888",
        }}
      >
        Loading assets…
      </div>
    );
  }

  const officeState = getOfficeState();

  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
      <div
        data-tauri-drag-region
        onMouseDown={async (e) => {
          if (e.button !== 0) return;
          try {
            const { getCurrentWindow } = await import("@tauri-apps/api/window");
            await getCurrentWindow().startDragging();
          } catch {
            /* non-Tauri runtime */
          }
        }}
        onDoubleClick={async () => {
          try {
            const { getCurrentWindow } = await import("@tauri-apps/api/window");
            const w = getCurrentWindow();
            if (await w.isMaximized()) await w.unmaximize();
            else await w.maximize();
          } catch {
            /* non-Tauri runtime */
          }
        }}
        style={{
          position: "absolute",
          top: 0,
          left: 80, // avoid native traffic-light area
          right: 0,
          height: 28,
          zIndex: 500,
          WebkitAppRegion: "drag",
        } as React.CSSProperties}
      />
      <OfficeCanvas
        officeState={officeState}
        onClick={handleClick}
        isEditMode={false}
        editorState={editorState}
        onEditorTileAction={noop}
        onEditorEraseAction={noop}
        onEditorSelectionChange={noop}
        onDeleteSelected={noop}
        onRotateSelected={noop}
        onDragMove={noop}
        editorTick={0}
        zoom={zoom}
        onZoomChange={handleZoomChange}
        panRef={panRef}
      />
      <MockEventPanel officeState={officeState} />
      <Legend />
      {!isTauriRuntime && <LangSwitch />}
    </div>
  );
}
