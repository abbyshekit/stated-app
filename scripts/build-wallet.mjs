// Self-host the pinned wallet SDK. Dropping console also removes the upstream
// SDK's unconditional payload logging; private wallet outcomes stay out of logs.
import { build } from 'esbuild';

await build({
  entryPoints: [new URL('../server/public/wallet-client.mjs', import.meta.url).pathname],
  outfile: new URL('../server/public/wallet.js', import.meta.url).pathname,
  bundle: true,
  platform: 'browser',
  target: ['es2022'],
  format: 'iife',
  minify: true,
  drop: ['console'],
  define: { 'process.env.NODE_ENV': '"production"', global: 'globalThis' },
  inject: [new URL('./wallet-globals.mjs', import.meta.url).pathname],
  legalComments: 'linked',
});
