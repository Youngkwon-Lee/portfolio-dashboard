// Compile with the already-installed TypeScript compiler, then use Node's test
// runner. No native transpiler, network, credentials, or live JWKS required.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const cache = resolve('node_modules/.cache');
mkdirSync(cache, { recursive: true });
const output = mkdtempSync(resolve(cache, 'access-tests-'));
function run(args) {
  const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Access test step failed (${result.status})`);
}
try {
  writeFileSync(resolve(output, 'package.json'), '{"type":"commonjs"}');
  run(['node_modules/typescript/bin/tsc', '--target', 'ES2022', '--module', 'commonjs',
    '--moduleResolution', 'node', '--esModuleInterop', '--skipLibCheck', '--strict',
    '--outDir', output, 'tests/access.test.ts']);
  run(['--test', resolve(output, 'tests/access.test.js')]);
} finally {
  rmSync(output, { recursive: true, force: true });
}
