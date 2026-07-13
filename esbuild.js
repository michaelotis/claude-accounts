const esbuild = require('esbuild');

const isWatch = process.argv.includes('--watch');
const isProduction = process.argv.includes('--production');

const buildOptions = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: !isProduction,
  minify: isProduction,
};

if (isWatch) {
  esbuild.context(buildOptions).then(ctx => ctx.watch());
} else {
  esbuild.build(buildOptions).catch(() => process.exit(1));
}
