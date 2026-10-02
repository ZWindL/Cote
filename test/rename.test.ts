import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { LocalStore } from '../src/storage/store';
import { createAnchor, resolveAnchor } from '../src/core/engine';
import { snapshot, TextIndex } from '../src/core/text';

test('a verified rename survives an unresolved cache and restart without changing provenance', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cote-rename-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const folder = path.join(root, 'workspace'); await fs.mkdir(folder);
  const store = await LocalStore.open(path.join(root, 'storage'), folder);
  const baseline = snapshot('before\nTARGET\nafter');
  const anchor = createAnchor({ workspaceId: store.workspaceId, relativePath: 'old.ts', snapshot: baseline, range: new TextIndex(baseline.text).range(7, 13) });
  const now = new Date().toISOString();
  await store.save({ note: { id: randomUUID(), revision: 0, body: 'kept', createdAt: now, updatedAt: now,
    original: anchor, accepted: anchor, pathHint: { relativePath: 'new.ts', evidence: 'verified-rename' },
    resolution: { status: 'unresolved', reason: 'deleted-target', evidence: [] } }, expectedRevision: null, snapshots: [baseline] });
  const reopened = await LocalStore.open(path.join(root, 'storage'), folder), [note] = await reopened.list();
  assert.equal(note.original.relativePath, 'old.ts'); assert.equal(note.accepted.relativePath, 'old.ts');
  const result = resolveAnchor({ accepted: note.accepted, baseline, candidates: [{ relativePath: note.pathHint!.relativePath,
    snapshot: baseline, pathEvidence: [note.pathHint!.evidence] }] });
  assert.equal(result.status, 'attached');
  assert.equal(result.location.relativePath, 'new.ts');
});
