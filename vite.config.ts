import react from "@vitejs/plugin-react";
import * as path from "path";
import type { Plugin } from "vite";
import { defineConfig } from "vite";

import { buildAssetIndex, buildFurnitureCatalog } from "./shared/assets/build.ts";
import {
  decodeAllCharacters,
  decodeAllFloors,
  decodeAllFurniture,
  decodeAllWalls,
} from "./shared/assets/loader.ts";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

interface DecodedCache {
  characters: ReturnType<typeof decodeAllCharacters> | null;
  floors: ReturnType<typeof decodeAllFloors> | null;
  walls: ReturnType<typeof decodeAllWalls> | null;
  furniture: ReturnType<typeof decodeAllFurniture> | null;
}

function browserMockAssetsPlugin(): Plugin {
  const assetsDir = path.resolve(__dirname, "public/assets");
  const cache: DecodedCache = { characters: null, floors: null, walls: null, furniture: null };

  function clearCache(): void {
    cache.characters = null;
    cache.floors = null;
    cache.walls = null;
    cache.furniture = null;
  }

  return {
    name: "browser-mock-assets",
    configureServer(server) {
      const base = server.config.base.replace(/\/$/, "");

      server.middlewares.use(`${base}/assets/furniture-catalog.json`, (_req, res) => {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(buildFurnitureCatalog(assetsDir)));
      });
      server.middlewares.use(`${base}/assets/asset-index.json`, (_req, res) => {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(buildAssetIndex(assetsDir)));
      });

      server.middlewares.use(`${base}/assets/decoded/characters.json`, (_req, res) => {
        cache.characters ??= decodeAllCharacters(assetsDir);
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(cache.characters));
      });
      server.middlewares.use(`${base}/assets/decoded/floors.json`, (_req, res) => {
        cache.floors ??= decodeAllFloors(assetsDir);
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(cache.floors));
      });
      server.middlewares.use(`${base}/assets/decoded/walls.json`, (_req, res) => {
        cache.walls ??= decodeAllWalls(assetsDir);
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(cache.walls));
      });
      server.middlewares.use(`${base}/assets/decoded/furniture.json`, (_req, res) => {
        cache.furniture ??= decodeAllFurniture(assetsDir, buildFurnitureCatalog(assetsDir));
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(cache.furniture));
      });

      server.watcher.add(assetsDir);
      server.watcher.on("change", (file) => {
        if (file.startsWith(assetsDir)) {
          clearCache();
          server.ws.send({ type: "full-reload" });
        }
      });
    },
    generateBundle() {
      const catalog = buildFurnitureCatalog(assetsDir);
      const emit = (fileName: string, data: unknown): void => {
        this.emitFile({
          type: "asset",
          fileName,
          source: JSON.stringify(data),
        });
      };
      emit("assets/furniture-catalog.json", catalog);
      emit("assets/asset-index.json", buildAssetIndex(assetsDir));
      emit("assets/decoded/characters.json", decodeAllCharacters(assetsDir));
      emit("assets/decoded/floors.json", decodeAllFloors(assetsDir));
      emit("assets/decoded/walls.json", decodeAllWalls(assetsDir));
      emit("assets/decoded/furniture.json", decodeAllFurniture(assetsDir, catalog));
    },
  };
}

export default defineConfig(async () => ({
  plugins: [react(), browserMockAssetsPlugin()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
