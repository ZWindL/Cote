import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import lockfile from 'proper-lockfile';
import { LocalStore, ConflictError, DurabilityError } from '../src/storage/store';
import { createAnchor } from '../src/core/engine';
import { snapshot, TextIndex } from '../src/core/text';
import { Note } from '../src/core/model';
const execute = promisify(execFile);
async function setup(t: { after(fn: () => Promise<void>): void }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cote-store-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace'), storage = path.join(root, 'storage');
  await fs.mkdir(workspace);
  const store = await LocalStore.open(storage, workspace);
  const source = snapshot('before\nTARGET\nafter\n');
  const anchor = createAnchor({ workspaceId: store.workspaceId, relativePath: 'test.ts',
    range: new TextIndex(source.text).range(7, 13), snapshot: source });
  const now = new Date().toISOString();
  const note: Note = { id: randomUUID(), revision: 0, body: '  plain\n`text` 你好 <html>', createdAt: now, updatedAt: now, original: anchor, accepted: anchor };
  const input = { note, expectedRevision: null, snapshots: [source] };
  return { root, workspace, storage, store, source, note, input };
}

test('restart preserves exact plaintext and immutable content-addressed snapshots', async t => {
  const { store, source, input, storage, workspace } = await setup(t);
  const saved = await store.save(input);
  assert.equal(saved.revision, 1);
  const reopened = await LocalStore.open(storage, workspace);
  assert.deepEqual(await reopened.list(), [saved]);
  assert.deepEqual(await reopened.readSnapshot(source.id), source);
  assert.deepEqual(await fs.readdir(workspace), []);
  await reopened.save({ note: { ...saved, body: 'new body' }, expectedRevision: 1, snapshots: [source] });
  assert.equal((await fs.readdir(store.snapshotsPath)).length, 1);
});
test('same-note revision conflict does not silently lose either draft', async t => {
  const { store, input } = await setup(t);
  const saved = await store.save(input);
  await store.save({ ...input, note: { ...saved, body: 'winner' }, expectedRevision: 1 });
  await assert.rejects(store.save({ ...input, note: { ...saved, body: 'draft retained by caller' }, expectedRevision: 1 }), ConflictError);
  assert.equal((await store.list())[0].body, 'winner');
  await assert.rejects(store.delete(saved.id, 1), ConflictError);
  assert.equal((await store.list()).length, 1);
});
test('independent processes merge different notes under one lock', async t => {
  const { store, input, root, storage, workspace } = await setup(t);
  const files = await Promise.all(Array.from({ length: 4 }, async (_, i) => {
    const file = path.join(root, `${i}.json`);
    await fs.writeFile(file, JSON.stringify({ ...input, note: { ...input.note, id: randomUUID(), body: `note ${i}` } }));
    return file;
  }));
  await Promise.all(files.map(file => execute(process.execPath, [path.join(__dirname, 'storage-process.js'), storage, workspace, file])));
  assert.deepEqual((await store.list()).map(n => n.body).sort(), ['note 0', 'note 1', 'note 2', 'note 3']);
  const manifest = JSON.parse(await fs.readFile(store.manifestPath, 'utf8'));
  assert.equal(manifest.generation, 4);
});
test('two processes writing the same revision produce one conflict', async t => {
  const { store, input, root, storage, workspace } = await setup(t);
  const saved = await store.save(input);
  const files = await Promise.all(['first', 'second'].map(async body => {
    const file = path.join(root, body + '.json');
    await fs.writeFile(file, JSON.stringify({ ...input, note: { ...saved, body }, expectedRevision: saved.revision }));
    return file;
  }));
  const results = await Promise.allSettled(files.map(file => execute(process.execPath, [path.join(__dirname, 'storage-process.js'), storage, workspace, file])));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const failed = results.find(r => r.status === 'rejected') as PromiseRejectedResult;
  assert.match(failed.reason.stderr, /REVISION_CONFLICT/);
  assert.equal((await store.list())[0].revision, 2);
});
test('interruption and disk failure before commit retain the old durable record', async t => {
  const { store, input, storage, workspace } = await setup(t);
  const saved = await store.save(input), old = await fs.readFile(store.manifestPath, 'utf8');
  for (const stage of ['before-snapshot-rename', 'before-manifest-rename']) {
    const failing = await LocalStore.open(storage, workspace, { fault(at) { if (at === stage) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); } });
    await assert.rejects(failing.save({ ...input, snapshots: [snapshot('new unused snapshot')], note: { ...saved, body: 'pending' }, expectedRevision: 1 }), /disk full/);
    assert.equal(await fs.readFile(store.manifestPath, 'utf8'), old);
    assert.equal((await store.list())[0].body, saved.body);
  }
});
test('post-commit failure reports committed state rather than promising durability', async t => {
  const { store, input, storage, workspace } = await setup(t);
  const failing = await LocalStore.open(storage, workspace, { fault(at) { if (at === 'after-manifest-rename') throw new Error('interrupted'); } });
  await assert.rejects(failing.save(input), DurabilityError);
  assert.equal((await store.list())[0].body, input.note.body);
});
test('active lock times out visibly, stale lock is safely reclaimed', async t => {
  const { store, input, storage, workspace } = await setup(t);
  const impatient = await LocalStore.open(storage, workspace, { lockTimeoutMs: 100 });
  const release = await lockfile.lock(store.directory);
  try { await assert.rejects(impatient.save(input), /locked|held/); } finally { await release(); }
  assert.equal((await store.list()).length, 0);
  const lock = store.directory + '.lock';
  await fs.mkdir(lock); const old = new Date(Date.now() - 10000); await fs.utimes(lock, old, old);
  assert.equal((await store.save(input)).revision, 1);
});
test('corrupt or missing snapshot retains note text and original excerpt', async t => {
  const { store, input, source } = await setup(t);
  await store.save(input);
  const filename = path.join(store.snapshotsPath, source.id);
  await fs.writeFile(filename, 'corrupted');
  await assert.rejects(store.readSnapshot(source.id), /Corrupt snapshot/);
  assert.equal((await store.list())[0].original.exact, 'TARGET');
  await assert.rejects(store.save({ ...input, note: { ...(await store.list())[0], body: 'try overwrite' }, expectedRevision: 1 }), /Corrupt snapshot/);
  await fs.unlink(filename);
  await assert.rejects(store.readSnapshot(source.id), /ENOENT/);
  assert.equal((await store.list())[0].body, input.note.body);
});
test('newer or corrupt manifest stays untouched and produces a visible recovery error', async t => {
  const { store, input, storage, workspace } = await setup(t);
  await store.save(input);
  for (const raw of ['{broken', JSON.stringify({ schemaVersion: 999 })]) {
    await fs.writeFile(store.manifestPath, raw);
    await assert.rejects(LocalStore.open(storage, workspace), /storage:/);
    await assert.rejects(store.save(input), /storage:/);
    assert.equal(await fs.readFile(store.manifestPath, 'utf8'), raw);
  }
});
test('validation rejects traversal, wrong hashes and altered original provenance', async t => {
  const { store, input } = await setup(t);
  await assert.rejects(store.save({ ...input, note: { ...input.note, accepted: { ...input.note.accepted, relativePath: '../outside' } } }), /anchor/);
  await assert.rejects(store.readSnapshot('../manifest.json'), /Invalid snapshot/);
  await assert.rejects(store.save({ ...input, snapshots: [{ id: input.snapshots[0].id, text: 'incorrect' }] }), /hash/);
  const saved = await store.save(input);
  await assert.rejects(store.save({ ...input, note: { ...saved, original: { ...saved.original, exact: 'wrong' } }, expectedRevision: 1 }), /immutable/);
});
test('canonical symlink namespace matches while separate folders stay distinct', async t => {
  const { root, store, storage, workspace } = await setup(t);
  const link = path.join(root, 'alias'), other = path.join(root, 'other');
  await fs.symlink(workspace, link); await fs.mkdir(other);
  assert.equal((await LocalStore.open(storage, link)).workspaceId, store.workspaceId);
  assert.notEqual((await LocalStore.open(storage, other)).workspaceId, store.workspaceId);
});
test('manifest watcher reports updates from another store', async t => {
  const { store, input, storage, workspace } = await setup(t);
  const other = await LocalStore.open(storage, workspace);
  const changed = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('No manifest notification')), 3000);
    const watcher = store.observe(() => { clearTimeout(timeout); watcher.dispose(); resolve(); });
    t.after(async () => { clearTimeout(timeout); watcher.dispose(); });
  });
  await other.save(input); await changed;
});
