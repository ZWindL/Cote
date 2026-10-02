import { diffLines, diffChars, Change } from 'diff';
import { Anchor, Candidate, ChangeInput, Range, Resolution, ResolveInput, Snapshot, unresolved } from './model';
import { TextIndex, validateSnapshot, validRelativePath } from './text';

export function createAnchor(input: { workspaceId: string; relativePath: string; range: Range; snapshot: Snapshot; git?: Anchor['git'] }): Anchor {
  validateSnapshot(input.snapshot);
  if (!validRelativePath(input.relativePath)) throw new Error('File must be inside the workspace');
  const index = new TextIndex(input.snapshot.text), [s, e] = index.offsets(input.range);
  const prefixStart = index.starts[Math.max(0, input.range.start.line - 3)];
  const suffixEnd = input.range.end.line + 4 < index.starts.length
    ? index.starts[input.range.end.line + 4] : index.text.length;
  return { workspaceId: input.workspaceId, relativePath: input.relativePath,
    range: { start: { line: input.range.start.line, character: input.range.start.character },
      end: { line: input.range.end.line, character: input.range.end.character } }, snapshotId: input.snapshot.id,
    exact: index.text.slice(s, e), prefix: index.text.slice(prefixStart, s), suffix: index.text.slice(e, suffixEnd),
    ...(input.git ? { git: input.git } : {}) };
}

export function validateAnchor(anchor: Anchor, baseline: Snapshot): void {
  validateSnapshot(baseline);
  if (anchor.snapshotId !== baseline.id) throw new Error('Anchor snapshot mismatch');
  const expected = createAnchor({ ...anchor, snapshot: baseline });
  for (const key of ['exact', 'prefix', 'suffix'] as const)
    if (expected[key] !== anchor[key]) throw new Error(`Anchor ${key} mismatch`);
}

function found(a: Anchor, c: Candidate, start: number, end: number, evidence: string[]): Resolution {
  try {
    const index = new TextIndex(c.snapshot.text), range = index.range(start, end);
    const exact = c.snapshot.text.slice(start, end);
    if (a.exact.length && !exact.length) return unresolved('deleted-target');
    return { status: exact === a.exact ? 'attached' : 'needs-review',
      location: { relativePath: c.relativePath, range, snapshotId: c.snapshot.id },
      evidence: [...new Set([...c.pathEvidence, ...evidence])] };
  } catch { return unresolved('invalid-boundary'); }
}

function occurrences(text: string, quote: string, deadline: number): number[] {
  const result: number[] = [];
  if (!quote) return result;
  let at = 0;
  while ((at = text.indexOf(quote, at)) >= 0) {
    if (Date.now() > deadline || result.length >= 10000) throw new Error('recovery-budget-exceeded');
    result.push(at++);
  }
  return result;
}
function contextMatches(a: Anchor, text: string, s: number, e: number, baseline: string): boolean {
  const [bs, be] = new TextIndex(baseline).offsets(a.range);
  return (a.prefix ? text.slice(Math.max(0, s - a.prefix.length), s) === a.prefix : bs === 0 && s === 0) &&
    (a.suffix ? text.slice(e, e + a.suffix.length) === a.suffix : be === baseline.length && e === text.length);
}
type Span = { oldStart: number; newStart: number; length: number };

// Use line correspondence first; refine only changed regions. A diff is evidence,
// never an identity oracle: ambiguous quotations are rejected separately.
function unchangedSpans(old: string, current: string, deadline: number): Span[] {
  const timeout = () => Math.max(1, deadline - Date.now());
  const changes = diffLines(old, current, { timeout: timeout() });
  if (!changes) throw new Error('recovery-budget-exceeded');
  const spans: Span[] = [];
  let o = 0, n = 0, removed = '', added = '', regionO = 0, regionN = 0;
  function flush() {
    if (!removed && !added) return;
    if (Date.now() > deadline) throw new Error('recovery-budget-exceeded');
    const refined = diffChars(removed, added, { timeout: timeout() });
    if (!refined) throw new Error('recovery-budget-exceeded');
    let ro = regionO, rn = regionN;
    for (const part of refined) {
      if (!part.added && !part.removed) spans.push({ oldStart: ro, newStart: rn, length: part.value.length });
      if (!part.added) ro += part.value.length;
      if (!part.removed) rn += part.value.length;
    }
    removed = ''; added = '';
  }
  for (const change of changes as Change[]) {
    if (change.added || change.removed) {
      if (!removed && !added) { regionO = o; regionN = n; }
      if (change.removed) { removed += change.value; o += change.value.length; }
      if (change.added) { added += change.value; n += change.value.length; }
    } else {
      flush();
      spans.push({ oldStart: o, newStart: n, length: change.value.length });
      o += change.value.length; n += change.value.length;
    }
  }
  flush();
  return spans;
}

function resolveFile(a: Anchor, baseline: Snapshot, c: Candidate, deadline: number): Resolution {
  const text = c.snapshot.text, [bs, be] = new TextIndex(baseline.text).offsets(a.range);
  if (baseline.id === c.snapshot.id) return found(a, c, bs, be, ['identical-snapshot']);
  // A pure EOL conversion preserves logical coordinates, not offsets.
  if (baseline.text.replace(/\r\n|\r/g, '\n') === text.replace(/\r\n|\r/g, '\n')) {
    const currentIndex = new TextIndex(text), [s, e] = currentIndex.offsets(a.range);
    const result = found(a, c, s, e, ['line-endings-only']);
    if (result.status !== 'unresolved') result.status = 'attached';
    return result;
  }
  if (Date.now() > deadline) throw new Error('recovery-budget-exceeded');
  if (a.exact) {
    const quotes = occurrences(text, a.exact, deadline);
    const supported = quotes.filter(s => contextMatches(a, text, s, s + a.exact.length, baseline.text));
    if (supported.length === 1) return found(a, c, supported[0], supported[0] + a.exact.length, ['unique-context']);
    if (supported.length > 1) return unresolved('ambiguous-match');
    if (quotes.length) {
      if (quotes.length !== 1 || occurrences(baseline.text, a.exact, deadline).length !== 1)
        return unresolved('ambiguous-match');
      const spans = unchangedSpans(baseline.text, text, deadline);
      const span = spans.find(p => p.oldStart <= bs && p.oldStart + p.length >= be &&
        p.newStart + bs - p.oldStart === quotes[0]);
      if (span) {
        const before = baseline.text.slice(span.oldStart, bs), after = baseline.text.slice(be, span.oldStart + span.length);
        // Require unchanged surrounding text on available sides. Whitespace alone
        // does not justify attaching an unrelated replacement at the same path.
        if ((bs === 0 || /\S/.test(before)) && (be === baseline.text.length || /\S/.test(after)))
          return found(a, c, quotes[0], quotes[0] + a.exact.length, ['unchanged-span']);
      }
      return unresolved('context-mismatch');
    }
  }
  // Unique two-sided brackets justify a replacement (or contextual blank line).
  // Never use empty-string searches or choose the closest bracket pair.
  const starts = a.prefix ? occurrences(text, a.prefix, deadline).map(s => s + a.prefix.length) : bs === 0 ? [0] : [];
  const ends = a.suffix ? occurrences(text, a.suffix, deadline) : be === baseline.text.length ? [text.length] : [];
  if (!a.prefix && !a.suffix) return unresolved('lost-context');
  const pairs: Array<[number, number]> = [];
  for (const s of starts) for (const e of ends) if (e >= s) {
    pairs.push([s, e]); if (pairs.length > 1) return unresolved('ambiguous-match');
  }
  if (pairs.length === 1) {
    const [s, e] = pairs[0];
    if (a.exact && s === e) return unresolved('deleted-target');
    if (!a.exact && s !== e) return unresolved('context-mismatch');
    return found(a, c, s, e, ['unique-context', ...(a.exact ? ['bracketed-replacement'] : [])]);
  }
  return unresolved(a.exact ? 'target-not-found' : 'lost-context');
}

export function resolveAnchor(input: ResolveInput, budgetMs = 2000): Resolution {
  try {
    validateAnchor(input.accepted, input.baseline);
    const deadline = Date.now() + budgetMs;
    const direct = input.candidates.find(c => c.relativePath === input.accepted.relativePath);
    const candidates = direct ? [direct] : input.candidates.filter(c =>
      c.pathEvidence.includes('editor-rename') || c.pathEvidence.includes('git-rename-candidate') || c.pathEvidence.includes('verified-rename'));
    if (!candidates.length) return unresolved('missing-file');
    const resolutions = candidates.map(c => {
      validateSnapshot(c.snapshot);
      if (!validRelativePath(c.relativePath)) return unresolved('invalid-path');
      const result = resolveFile(input.accepted, input.baseline, c, deadline);
      if (result.status !== 'unresolved' && c.relativePath !== input.accepted.relativePath) result.evidence.push('verified-rename');
      return result;
    });
    const located = resolutions.filter(r => r.status !== 'unresolved');
    if (located.length > 1) return unresolved('ambiguous-rename');
    return located[0] ?? resolutions[0];
  } catch (error) {
    return unresolved(error instanceof Error && error.message === 'recovery-budget-exceeded'
      ? error.message : 'unavailable-snapshot');
  }
}

export function applyBufferChanges(input: ChangeInput): Resolution {
  const { accepted, baseline, before, after, previous, edits } = input;
  const fallback = () => resolveAnchor({ accepted, baseline, candidates: [{
    relativePath: previous.status === 'unresolved' ? accepted.relativePath : previous.location.relativePath,
    snapshot: after, pathEvidence: previous.status === 'unresolved' ? [] : previous.evidence.filter(e => e.includes('rename')) }] });
  try {
    validateAnchor(accepted, baseline); validateSnapshot(before); validateSnapshot(after);
    if (after.id === baseline.id) return fallback();
    if (previous.status === 'unresolved' || previous.location.snapshotId !== before.id) return fallback();
    const index = new TextIndex(before.text);
    const normalized = edits.map(edit => { const [s, e] = index.offsets(edit.range); return { s, e, text: edit.text }; })
      .sort((a, b) => a.s - b.s || a.e - b.e);
    for (let i = 1; i < normalized.length; i++) if (normalized[i].s < normalized[i - 1].e || normalized[i].s === normalized[i - 1].s)
      return fallback();
    let reconstructed = before.text;
    for (const edit of [...normalized].reverse()) reconstructed = reconstructed.slice(0, edit.s) + edit.text + reconstructed.slice(edit.e);
    if (reconstructed !== after.text) return fallback();
    const [start, end] = index.offsets(previous.location.range);
    if (start !== end && normalized.some(e => e.s <= start && e.e >= end && !e.text)) return unresolved('deleted-target', ['live-edit']);
    if (start !== end && normalized.some(e => e.s <= start && e.e >= end && (e.s < start || e.e > end)))
      return unresolved('lost-context', ['live-edit']);
    const map = (p: number, isStart: boolean): number => {
      let shift = 0;
      for (const edit of normalized) {
        if (edit.s === edit.e) {
          if (edit.s < p || (edit.s === p && (isStart || start === end))) shift += edit.text.length;
        } else if (edit.e <= p) shift += edit.text.length - (edit.e - edit.s);
        else if (edit.s < p || (edit.s === p && isStart)) return edit.s + shift + (isStart ? 0 : edit.text.length);
      }
      return p + shift;
    };
    const s = map(start, true), e = map(end, false);
    if (e < s || (accepted.exact.length > 0 && s === e)) return unresolved('deleted-target', ['live-edit']);
    return found(accepted, { relativePath: previous.location.relativePath, snapshot: after,
      pathEvidence: previous.evidence.filter(e => e.includes('rename')) }, s, e, ['live-edit']);
  } catch { return fallback(); }
}
