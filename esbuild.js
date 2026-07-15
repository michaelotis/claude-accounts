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
];

async function run() {
  if (isWatch) {
    const ctx = await esbuild.context(builds[0]);
    for (let i = 1; i < builds.length; i++) {
      await esbuild.build(builds[i]);
    }
    await ctx.watch();
    return;
  }
  for (const b of builds) {
    await esbuild.build(b);
  }
}

run().catch(() => process.exit(1));
