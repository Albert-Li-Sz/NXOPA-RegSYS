import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { cp, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
const dependencyRequire = createRequire(import.meta.url);
const pdfRoot = dirname(dependencyRequire.resolve('pdfjs-dist/package.json'));
const pdfVersion = dependencyRequire('pdfjs-dist/package.json').version;
export default defineConfig({
  plugins: [
    vue(),
    {
      name: 'pdf-preview-assets',
      async configResolved(config) {
        const target = resolve(config.publicDir, 'pdfjs', pdfVersion);
        await mkdir(target, { recursive: true });
        for (const item of ['cmaps', 'standard_fonts', 'wasm', 'iccs', 'LICENSE'])
          await cp(resolve(pdfRoot, item), resolve(target, item), {
            recursive: true,
            force: false,
            errorOnExist: false,
          });
      },
    },
  ],
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': process.env.API_PROXY_TARGET ?? 'http://localhost:3000' },
  },
});
