const esbuild = require('esbuild');
const options = { bundle: true, platform: 'node', target: 'node20', format: 'cjs', sourcemap: true };
Promise.all([
  esbuild.build({ ...options, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js', external: ['vscode'] }),
  esbuild.build({ ...options, entryPoints: ['src/core/worker.ts'], outfile: 'dist/worker.js' })
]).catch(error => { console.error(error); process.exitCode = 1; });
