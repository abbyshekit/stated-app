// Self-host the pinned wallet SDK. Dropping console also removes the upstream
// SDK's unconditional payload logging; private wallet outcomes stay out of logs.
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { build } from 'esbuild';

// The SDK imports { stringify } from query-string. package.json pins query-string 9.5.1, which
// fixes the decode-uri-component denial of service in 7.x; 9 exports stringify by name only from
// base.js, so the SDK's import is pointed there.
const queryStringBase = join(dirname(createRequire(import.meta.url).resolve('query-string')), 'base.js');
const queryString = { name: 'query-string-named', setup(b) { b.onResolve({ filter: /^query-string$/ }, () => ({ path: queryStringBase })); } };

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
  plugins: [queryString],
});
