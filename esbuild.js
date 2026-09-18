const esbuild = require('esbuild');

const isWatch = process.argv.includes('--watch');
const isProduction = process.argv.includes('--production');

const builds = [
  {
    entryPoints: ['src/extension.ts'],
    bundle: true,
    outfile: 'dist/extension.js',
    external: ['vscode'],
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    sourcemap: !isProduction,
    minify: isProduction,
  },
  {
    // The usage CLI runs with no VS Code around it, so nothing is marked
    // external: an import that reaches `vscode` from anywhere in its graph has
    // to fail this build rather than the command.
    entryPoints: ['src/usageCli.ts'],
    bundle: true,
    outfile: 'dist/usage-cli.js',
    banner: { js: '#!/usr/bin/env node' },
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    sourcemap: !isProduction,
    minify: isProduction,
  },
];

async function run() {
  if (isWatch) {
    // One context per entry: a context only watches its own build, so anything
    // built once here simply goes stale for the rest of the session.
    const contexts = await Promise.all(builds.map((b) => esbuild.context(b)));
    await Promise.all(contexts.map((ctx) => ctx.watch()));
    return;
  }
  for (const b of builds) {
    await esbuild.build(b);
  }
}

run().catch(() => process.exit(1));
