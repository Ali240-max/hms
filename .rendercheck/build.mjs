import * as esbuild from 'esbuild'
await esbuild.build({
  entryPoints: ['.rendercheck/entry.tsx'],
  bundle: true, platform: 'node', format: 'esm', outfile: '.rendercheck/out.mjs',
  jsx: 'automatic', external: ['react', 'react-dom', 'react-dom/server'],
  loader: { '.css': 'empty' }
})
