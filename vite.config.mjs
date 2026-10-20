import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
export default defineConfig({ base: './', build: {outDir:'dist', sourcemap:false,rollupOptions:{input:{main:fileURLToPath(new URL('./index.html',import.meta.url)),remote:fileURLToPath(new URL('./remote.html',import.meta.url))}}}, plugins: [{
  name: 'public-app-shell',
  generateBundle(_options, bundle) {
    const paths = Object.keys(bundle).filter(name => name.startsWith('assets/')).map(name => `/${name}`);
    const version = createHash('sha256').update(paths.join('\n')).digest('hex').slice(0, 12);
    this.emitFile({ type: 'asset', fileName: 'shell-assets.json', source: JSON.stringify(paths) });
    this.emitFile({ type: 'asset', fileName: 'sw.js', source: readFileSync(new URL('./public/sw.js', import.meta.url), 'utf8').replace('exomina-shell-v1', `exomina-shell-${version}`) });
  },
}] });
