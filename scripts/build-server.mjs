import * as esbuild from 'esbuild'

/**
 * Bundle the server to a single file for production.
 *
 * `tsc` is not used for this. The server tsconfig is set to `noEmit` because
 * its job is type-checking, and `moduleResolution: bundler` means tsc could
 * not emit runnable ESM from it anyway — extensionless imports that Node
 * refuses to resolve. The result was a `npm start` that pointed at a file
 * which had never been written.
 *
 * Dependencies stay external rather than being bundled in: `pg` and friends
 * load optional native pieces at runtime, and inlining them turns a working
 * install into a mystery. node_modules therefore has to be present in
 * production, which it is — the same folder is deployed.
 */
await esbuild.build({
  entryPoints: ['src/server/index.ts'],
  outfile: 'dist/server/index.js',
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  packages: 'external',
  sourcemap: true,
  logLevel: 'info'
})
