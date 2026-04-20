import "./index.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App";
import { isBrowserRuntime } from "./runtime";

async function main() {
  if (isBrowserRuntime) {
    const { initBrowserMock } = await import("./browserMock.js");
    await initBrowserMock();
  }
  createRoot(document.getElementById("root") as HTMLElement).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void main().catch(console.error);
