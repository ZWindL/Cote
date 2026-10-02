import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { captureGit, parseRenames, renameCandidates } from '../src/git/adapter';
const execute = promisify(execFile);
test('NUL-delimited Git names preserve spaces, Unicode, tabs and newlines', () => {
  assert.deepEqual(parseRenames('M\0normal\0R100\0old\n名.ts\0new\tname.ts\0D\0gone\0'), [{ from: 'old\n名.ts', to: 'new\tname.ts' }]);
});
test('Git metadata and rename candidates are optional and read-only', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cote-git-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  assert.equal(await captureGit(root, path.join(root, 'file')), undefined);
  assert.deepEqual(await renameCandidates(root, undefined), []);
  const git = (...args: string[]) => execute('git', args, { cwd: root });
  await git('init', '-q');
  await fs.writeFile(path.join(root, 'old name.ts'), 'function sample() {\n  return 42;\n}\n');
  await git('add', '.'); await git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
  const metadata = await captureGit(root, path.join(root, 'old name.ts'));
  assert.ok(metadata);
  await git('mv', 'old name.ts', 'new name.ts');
  const before = (await git('status', '--porcelain=v1', '-z')).stdout;
  assert.deepEqual(await renameCandidates(root, metadata), ['new name.ts']);
  assert.equal((await git('status', '--porcelain=v1', '-z')).stdout, before);
  assert.deepEqual(await renameCandidates(root, { ...metadata, head: '0'.repeat(40) }), []);
});
