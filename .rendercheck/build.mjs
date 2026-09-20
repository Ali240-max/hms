import * as esbuild from 'esbuild'

/**
 * Bundle every screen for a server-side render check.
 *
 * `mainFields` matters: lucide-react ships both a CommonJS and an ESM build,
 * and esbuild targeting node picks the CommonJS one by default. That build
 * calls require('react') at load time, which an ESM bundle cannot do — the
 * harness died before rendering a single screen. Asking for the module field
 * first takes the ESM build instead.
 */
await esbuild.build({
  entryPoints: ['.rendercheck/entry.tsx'],
  bundle: true, platform: 'node', format: 'esm', outfile: '.rendercheck/out.mjs',
  jsx: 'automatic', external: ['react', 'react-dom', 'react-dom/server'],
  mainFields: ['module', 'main'],
  conditions: ['import', 'module'],
  loader: { '.css': 'empty' }
})
