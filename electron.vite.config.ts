import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import type { Plugin } from 'vite';

/**
 * electron-vite builds three bundles with Vite:
 *   main     electron/main.ts     → out/main/index.js     (ESM, Node APIs)
 *   preload  electron/preload.ts  → out/preload/index.cjs (CommonJS: sandboxed preloads cannot be ESM)
 *   renderer index.html + src/    → out/renderer/         (React)
 * Dependencies are loaded from node_modules at runtime (externalized) and packaged by electron-builder.
 */

// Must match PROD_CSP in electron/main.ts.
const PROD_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'";

function productionCsp(): Plugin {
  return {
    name: 'inject-production-csp',
    apply: 'build',
    transformIndexHtml: (html) =>
      html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${PROD_CSP}" />`),
  };
}

/** Shown under the version in the sidebar, so the operator can tell which build is installed. */
function buildId(): string {
  let commit = 'dev';
  try {
    commit = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || commit;
  } catch {
    // Not a git checkout; keep "dev".
  }
  return `${new Date().toISOString().slice(0, 10)} · ${commit}`;
}

const alias = { '@shared': resolve(import.meta.dirname, 'shared'), '@': resolve(import.meta.dirname, 'src') };

export default defineConfig({
  main: {
    resolve: { alias },
    build: {
      rollupOptions: { input: { index: resolve(import.meta.dirname, 'electron/main.ts') } },
    },
  },
  preload: {
    resolve: { alias },
    build: {
      rollupOptions: {
        input: { index: resolve(import.meta.dirname, 'electron/preload.ts') },
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: '.',
    resolve: { alias },
    plugins: [react(), tailwindcss(), productionCsp()],
    define: { __BUILD_ID__: JSON.stringify(buildId()) },
    build: {
      rollupOptions: { input: { index: resolve(import.meta.dirname, 'index.html') } },
    },
  },
});
