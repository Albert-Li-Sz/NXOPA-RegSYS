import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { cp, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
const pdfRoot = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
export default defineConfig({
  plugins: [
    vue(),
    {
      name: 'pdf-preview-assets',
      async configResolved(config) {
        const target = resolve(config.publicDir, 'pdfjs');
        await mkdir(target, { recursive: true });
        for (const item of ['cmaps', 'standard_fonts', 'wasm', 'iccs', 'LICENSE'])
          await cp(resolve(pdfRoot, item), resolve(target, item), { recursive: true });
      },
    },
  ],
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': process.env.API_PROXY_TARGET ?? 'http://localhost:3000' },
  },
});
