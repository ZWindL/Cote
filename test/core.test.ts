import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createAnchor, resolveAnchor, applyBufferChanges } from '../src/core/engine';
import { recover } from '../src/core/recovery';
import { TextIndex, snapshot } from '../src/core/text';
import { Resolution } from '../src/core/model';

type Fixture = { name: string; baseline: string; start: number; end: number; target: string;
  status: Resolution['status']; selected?: string; targetStart?: number; reason?: string; evidence?: string;
  edits?: Array<{ start: number; end: number; text: string }> };
const fixtures: Fixture[] = JSON.parse(readFileSync('test/fixtures/anchoring.json', 'utf8'));
for (const f of fixtures) test(f.name, () => {
  const baseline = snapshot(f.baseline), current = snapshot(f.target), index = new TextIndex(f.baseline);
  const accepted = createAnchor({ workspaceId: 'test', relativePath: 'src/sample.ts', range: index.range(f.start, f.end), snapshot: baseline });
  const initial = resolveAnchor({ accepted, baseline, candidates: [{ relativePath: accepted.relativePath, snapshot: baseline, pathEvidence: [] }] });
  const result = f.edits ? applyBufferChanges({ accepted, baseline, before: baseline, after: current, previous: initial,
    edits: f.edits.map(e => ({ range: index.range(e.start, e.end), text: e.text })) })
    : resolveAnchor({ accepted, baseline, candidates: [{ relativePath: accepted.relativePath, snapshot: current, pathEvidence: [] }] });
  assert.equal(result.status, f.status, JSON.stringify(result));
  if (result.status !== 'unresolved') {
    const idx = new TextIndex(f.target);
    assert.equal(idx.selected(result.location.range), f.selected ?? accepted.exact);
    if (f.targetStart !== undefined) assert.equal(idx.offset(result.location.range.start), f.targetStart);
    assert.equal(result.location.snapshotId, current.id);
  } else if (f.reason) assert.equal(result.reason, f.reason);
  if (f.evidence) assert.ok(result.evidence.includes(f.evidence));
  assert.equal(accepted.snapshotId, baseline.id);
  assert.equal(accepted.exact, f.baseline.slice(f.start, f.end));
});

test('coordinate validation rejects split surrogate pairs, CRLF interiors and invalid ranges', () => {
  const i = new TextIndex('a👋é\r\nlast');
  assert.throws(() => i.offset({ line: 0, character: 2 }), /surrogate/);
  assert.throws(() => i.position(6), /terminator/);
  assert.throws(() => i.offset({ line: 0, character: 6 }), /outside/);
  assert.throws(() => i.range(5, 0), /./); // range itself also validates ordering
});
test('end-exclusive multiline ranges and EOF are exact', () => {
  const i = new TextIndex('😀\r\nhello\r\n');
  assert.equal(i.selected({ start: { line: 0, character: 0 }, end: { line: 1, character: 0 } }), '😀\r\n');
  assert.deepEqual(i.position(i.text.length), { line: 2, character: 0 });
});
test('missing and ambiguous renamed files stay unresolved', () => {
  const baseline = snapshot('header\nselected\nfooter'), index = new TextIndex(baseline.text);
  const accepted = createAnchor({ workspaceId: 'test', relativePath: 'old.ts', range: index.range(7, 15), snapshot: baseline });
  assert.deepEqual(resolveAnchor({ accepted, baseline, candidates: [] }), { status: 'unresolved', reason: 'missing-file', evidence: [] });
  const candidates = ['new.ts', 'other.ts'].map(relativePath => ({ relativePath, snapshot: baseline, pathEvidence: ['git-rename-candidate'] }));
  assert.equal((resolveAnchor({ accepted, baseline, candidates }) as { reason: string }).reason, 'ambiguous-rename');
  const single = resolveAnchor({ accepted, baseline, candidates: candidates.slice(0, 1) });
  assert.equal(single.status, 'attached'); assert.ok(single.evidence.includes('verified-rename'));
  assert.equal(resolveAnchor({ accepted, baseline, candidates: [{ ...candidates[0], pathEvidence: [] }] }).status, 'unresolved');
});
test('deleted target returns on undo; redo loses it again', () => {
  const baseline = snapshot('before\nTARGET\nafter'), index = new TextIndex(baseline.text);
  const accepted = createAnchor({ workspaceId: 'test', relativePath: 'file', range: index.range(7, 13), snapshot: baseline });
  const candidate = (s: typeof baseline) => [{ relativePath: 'file', snapshot: s, pathEvidence: [] }];
  const initial = resolveAnchor({ accepted, baseline, candidates: candidate(baseline) });
  const deleted = snapshot('before\n\nafter');
  const result = applyBufferChanges({ accepted, baseline, before: baseline, after: deleted, previous: initial,
    edits: [{ range: index.range(7, 13), text: '' }] });
  assert.equal(result.status, 'unresolved');
  const undone = applyBufferChanges({ accepted, baseline, before: deleted, after: baseline, previous: result,
    edits: [{ range: new TextIndex(deleted.text).range(7, 7), text: 'TARGET' }] });
  assert.equal(undone.status, 'attached');
  assert.equal(applyBufferChanges({ accepted, baseline, before: baseline, after: deleted, previous: undone,
    edits: [{ range: index.range(7, 13), text: '' }] }).status, 'unresolved');
});
test('worker cancellation and exhausted budget return explicit unresolved results', async () => {
  const baseline = snapshot('before\nTARGET\nafter');
  const accepted = createAnchor({ workspaceId: 'test', relativePath: 'file', range: new TextIndex(baseline.text).range(7, 13), snapshot: baseline });
  const input = { accepted, baseline, candidates: [{ relativePath: 'file', snapshot: snapshot('totally different'), pathEvidence: [] }] };
  assert.equal((await recover(input, AbortSignal.abort()) as { reason: string }).reason, 'recovery-cancelled');
  assert.equal((await recover(input, undefined, 0) as { reason: string }).reason, 'recovery-budget-exceeded');
  assert.equal((resolveAnchor(input, -1) as { reason: string }).reason, 'recovery-budget-exceeded');
});
test('invalid event reconstruction falls back to snapshots, never guessed offsets', () => {
  const baseline = snapshot('before\nTARGET\nafter'), index = new TextIndex(baseline.text);
  const accepted = createAnchor({ workspaceId: 'test', relativePath: 'file', range: index.range(7, 13), snapshot: baseline });
  const initial = resolveAnchor({ accepted, baseline, candidates: [{ relativePath: 'file', snapshot: baseline, pathEvidence: [] }] });
  const result = applyBufferChanges({ accepted, baseline, before: baseline, after: snapshot('unrelated'), previous: initial,
    edits: [{ range: index.range(0, 0), text: 'not the real edit' }] });
  assert.equal(result.status, 'unresolved');
});
