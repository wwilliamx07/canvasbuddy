import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import webExtension from "vite-plugin-web-extension";
import fs from 'node:fs';
import path from 'node:path';

function removeReservedViteChunks() {
  let outDir = 'dist';
  return {
    name: 'remove-reserved-vite-chunks',
    configResolved(config: any) {
      outDir = config.build.outDir || 'dist';
    },
    generateBundle(_options: unknown, bundle: Record<string, { type: string }>) {
      for (const fileName of Object.keys(bundle)) {
        if (fileName.startsWith('__vite-browser-external')) {
          delete bundle[fileName];
        }
      }
    },
    closeBundle() {
      const reservedFile = path.join(outDir, '__vite-browser-external.js');
      if (fs.existsSync(reservedFile)) {
        fs.rmSync(reservedFile, { force: true });
      }
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    removeReservedViteChunks(),
    webExtension({
      manifest: "./manifest.json", // point to wherever your manifest lives
    }),
  ],
  optimizeDeps: {
    exclude: ["@electric-sql/pglite", "@electric-sql/pglite-pgvector"],
  },
});