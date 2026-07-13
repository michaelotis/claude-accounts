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
  // Shared selection logic for scripts/claude-orch (no vscode)
  {
    entryPoints: ['src/usageParse.ts'],
    bundle: true,
    outfile: 'scripts/lib/usageParse.cjs',
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    sourcemap: false,
    minify: false,
  },
];

async function run() {
  if (isWatch) {
    const ctx = await esbuild.context(builds[0]);
    await esbuild.build(builds[1]);
    await ctx.watch();
    return;
  }
  for (const b of builds) {
    await esbuild.build(b);
  }
}

run().catch(() => process.exit(1));
