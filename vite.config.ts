import react from '@vitejs/plugin-react';
import { cpSync, createReadStream, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

const root = dirname(fileURLToPath(import.meta.url));

/**
 * Flou d'arrière-plan de la visio : le moteur (MediaPipe, WebAssembly) et son modèle sont servis
 * par Alfred lui-même, jamais par un service externe. Ils sont copiés tels quels sous
 * /assets/flou-<version>/ (dossier versionné, donc gardé en cache par le navigateur).
 */
function blurAssets(): Plugin {
  const wasmDir = join(root, 'node_modules/@mediapipe/tasks-vision/wasm');
  const version = (JSON.parse(readFileSync(join(root, 'node_modules/@mediapipe/tasks-vision/package.json'), 'utf8')) as { version: string }).version;
  const files = [
    ...['vision_wasm_internal.js', 'vision_wasm_internal.wasm', 'vision_wasm_nosimd_internal.js', 'vision_wasm_nosimd_internal.wasm'].map((f) => join(wasmDir, f)),
    join(root, 'web/visio-flou/selfie_segmenter.tflite'),
  ];
  const base = `/assets/flou-${version}`;
  const types: Record<string, string> = { js: 'text/javascript', wasm: 'application/wasm', tflite: 'application/octet-stream' };
  let outDir = '';
  return {
    name: 'alfred-blur-assets',
    config: () => ({ define: { __BLUR_ASSETS__: JSON.stringify(base) } }),
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? '').split('?')[0];
        const file = path.startsWith(`${base}/`) ? files.find((f) => basename(f) === path.slice(base.length + 1)) : undefined;
        if (!file || !existsSync(file)) return next();
        res.setHeader('Content-Type', types[file.split('.').pop() ?? ''] ?? 'application/octet-stream');
        createReadStream(file).pipe(res);
      });
    },
    closeBundle() {
      const dest = join(outDir, base);
      mkdirSync(dest, { recursive: true });
      for (const f of files) cpSync(f, join(dest, basename(f)));
    },
  };
}

export default defineConfig({
  root: 'web',
  plugins: [react(), blurAssets()],
  build: { outDir: '../dist/web', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:3200', '/healthz': 'http://127.0.0.1:3200' },
  },
});
