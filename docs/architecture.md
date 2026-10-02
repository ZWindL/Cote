# Cote v1: architecture

Status: implementation specification · 2026-09-19

A TypeScript VS Code extension owns the UI and local persistence. An editor-independent TypeScript module owns anchor creation, text-change mapping, and recovery. See [product design](product-design.md) for interactions and [anchoring design](anchoring-design.md) for resolution rules and fixtures.

## Components and data flow

1. **VS Code adapter:** converts selections and document events to core values, captures exact document text, and renders one native comment thread per located note. It never inserts source comments or saves a source document as a side effect.
2. **Anchor core:** operates on supplied snapshots and normalized edits without importing VS Code APIs. Uses jsdiff for line/character comparison and returns explicit status and evidence.
3. **Git adapter:** optionally reads HEAD metadata and rename candidates using the installed Git CLI. It supplies evidence to the core; it does not decide attachment by similarity score alone.
4. **Local store:** stores note records and immutable content-addressed snapshots. It provides serialized, revision-checked writes and atomic manifest replacement.

On note creation, capture a document version and snapshot, create its anchor, persist snapshot and record, then acknowledge Save. On live edits, map ranges immediately and refresh threads; debounce durable resolution-cache updates by 500 ms. The accepted anchor is never changed by these updates. On activation, file opening, external modification, or Git HEAD change, resolve against the latest content. Unsaved open-buffer content takes precedence over disk content. Before presenting an asynchronous result, verify the document version still matches; discard stale results.

Do not diff an entire repository on every keystroke. Resolve open files first and other notes when navigated or when relevant file events occur. Cache results by anchor revision and target snapshot hash. Bound each background diff/search job to two seconds; cancellation, exhaustion, or unsupported input yields a retryable unresolved result. Run costly recovery in a worker so the extension host stays responsive.

## Minimum interfaces and records

The following sketches describe contracts, not a published package API. All coordinates use the convention in the anchoring specification.

```ts
type Position = { line: number; character: number }; // UTF-16 units
type Range = { start: Position; end: Position };     // half-open

type Snapshot = { id: string; text: string };        // SHA-256 of UTF-8 text

type Anchor = {
  workspaceId: string;
  relativePath: string;
  range: Range;
  exact: string;
  prefix: string;
  suffix: string;
  snapshotId: string;
  git?: { head: string; repositoryRelativePath: string };
};

type Location = {
  relativePath: string;
  range: Range;
  snapshotId: string;
};

type Resolution =
  | { status: 'attached' | 'needs-review'; location: Location;
      evidence: string[] }
  | { status: 'unresolved'; reason: string; evidence: string[] };

type Note = {
  id: string;
  revision: number;
  body: string;
  createdAt: string;
  updatedAt: string;
  original: Anchor;
  accepted: Anchor;
  resolution?: Resolution;
  pathHint?: { relativePath: string; evidence: 'verified-rename' };
};

type TextEdit = { range: Range; text: string }; // pre-change coordinates

interface AnchorEngine {
  createAnchor(input: {
    workspaceId: string; relativePath: string;
    range: Range; snapshot: Snapshot; git?: Anchor['git'];
  }): Anchor;
  resolveAnchor(input: {
    accepted: Anchor; baseline: Snapshot;
    candidates: Array<{ relativePath: string; snapshot: Snapshot;
                        pathEvidence: string[] }>;
    previous?: { location: Location; snapshot: Snapshot };
  }): Resolution;
  applyBufferChanges(input: {
    accepted: Anchor; baseline: Snapshot;
    before: Snapshot; after: Snapshot;
    previous: Resolution; edits: TextEdit[];
  }): Resolution;
}

interface NoteStore {
  list(workspaceId: string): Promise<Note[]>;
  readSnapshot(id: string): Promise<Snapshot>;
  save(input: {
    note: Note; expectedRevision: number | null;
    snapshots: Snapshot[];
  }): Promise<Note>; // null means create; store assigns next revision
  delete(id: string, expectedRevision: number): Promise<void>;
}
```

Use UUIDs for note IDs, ISO timestamps, and a versioned manifest envelope. Evidence strings are stable machine-readable codes such as `identical-snapshot`, `unique-context`, `live-edit`, `verified-rename`, and `line-endings-only`; user-facing explanations are separate. Unresolved reasons distinguish missing file, deleted target, ambiguous match, unavailable snapshot, and exhausted recovery budget.

The optional path hint records an editor rename or content-verified rename independently of the latest resolution. This retains the known destination across restart even if the target subsequently becomes unresolved. It never changes the original or accepted anchor, and the destination content must still be verified before showing a thread.

On **Confirm reviewed** or **Reattach**, create a new accepted anchor from the current buffer, preserve `original`, and save with an expected revision. Git metadata is optional at capture and must not block the operation. Storage validation checks range bounds, selected-text consistency, workspace membership, and snapshot hashes. Treat invalid records as visible recovery errors rather than dropping notes.

## Persistence and concurrent windows

Use the extension's `globalStorageUri` on the local extension host. Under it, namespace each workspace folder by SHA-256 of its canonical real filesystem URI. Resolve symlinks through the filesystem; do not lowercase paths arbitrarily. Record the canonical URI alongside the hash for validation. Separate clones/worktrees remain independent; workspace moves do not automatically merge stores. Remote and virtual workspaces are unsupported in v1.

Within each namespace, keep a versioned JSON manifest containing note records and a snapshots directory keyed by SHA-256. Deduplicate snapshots within the namespace. Keep snapshots referenced by original anchors, accepted anchors, and current resolution locations; initial v1 does not garbage-collect snapshots, avoiding premature deletion. Document disk-growth implications in extension help. No network sync or telemetry is required.

Use a maintained filesystem-lock package such as `proper-lockfile` for a per-workspace cross-process lock; pin its compatible version during implementation and test its stale-lock behavior. All writers must acquire the same lock. Under the lock, reread the manifest, check expected record revision, merge only the intended record change, and increment the manifest generation. Serialize cache writes too, and reject results based on a stale note revision.

Write missing snapshots first via temporary files and same-directory atomic rename; validate an existing snapshot's hash before reuse. Flush files before replacing the manifest. Write the new manifest to a unique temporary sibling, flush it, and atomically rename it over the prior manifest. Sync directory entries where supported. A successful rename is the commit point; report durability errors accurately rather than claiming stronger guarantees than the platform provides. Readers see either the complete old or new manifest. A crash before commit may leave unused snapshots or temporary files, which do not affect active records.

A same-note revision conflict returns a conflict error, preserves the user's draft, and offers Reload or an explicit overwrite after showing the latest version. Never silently overwrite. Different-note updates merge under the lock. If locking is unavailable or times out after five seconds, fail the write visibly and offer Retry; do not write unlocked. Observe manifest changes to refresh other windows, retaining local drafts until the user resolves conflicts.

Unknown newer schema versions open read-only with an explanatory error. V1 uses schema version 1 and has no prior migration. Corrupt stores must not be silently recreated; retain files and expose the error with their storage location. Original excerpts remain readable from anchor fields even if a snapshot cannot be recovered. Persisted plaintext includes code snapshots; users must be told that private code excerpts remain in local extension storage after source deletion.

## Git and dependency boundaries

Use jsdiff's maintained `diff` package for pure text comparisons. Pin an implementation-tested version and keep recovery policy outside the package: a valid diff is not proof of identity. Respect time budgets and duplicate-match checks.

Invoke Git with an argument array through a process API, never by interpolating paths into a shell command. Use read-only operations and disable external diff/textconv execution. Parse NUL-delimited path output. Resolve the repository root separately from the workspace root. Read-only operations may obtain HEAD and inspect rename candidates with `git diff --name-status -z --find-renames --no-ext-diff --no-textconv` against a stored revision, when available. Missing Git, missing objects, and untracked destinations reduce available evidence rather than failing note creation. Git may not detect a working-tree move to an untracked file; leave such notes unresolved unless an editor rename event provides the relationship. Never run add, checkout, apply, or update-index to support notes.

| Alternative | Decision |
| --- | --- |
| libgit2 | Defer: rich native Git APIs do not remove anchoring policy and add packaging/ABI work. |
| Syntax trees or language servers | Defer: may supply symbol context later but add language dependencies and cannot guarantee semantic identity across refactors. |
| Fuzzy text matching | Defer: could suggest candidates later; v1 uses conservative exact/context recovery. |
| Custom inline widgets | Defer: validate supported Comments API first; do not rely on editor internals. |
| Shared native executable/service | Defer: unnecessary for a single editor and increases installation/protocol complexity. |

## Future Neovim adapter

Neovim can use extmarks for live buffer tracking and virtual lines or floating windows for presentation. Extmarks do not replace the persisted snapshot/anchor model or review policy. The adapter must convert UTF-8 byte columns using actual line text and match Cote's boundary-insertion behavior. Undo and full deletion still require status handling.

Keep shared language-neutral JSON fixtures containing snapshots, anchors, edits, and expected resolutions. A future Lua port or separately packaged shared engine must pass those fixtures before claiming compatibility. V1 commits to a documented versioned model, not to a cross-editor runtime or concurrent storage access by an unimplemented client.

## Implementation gates and validation

1. Pass the native comment-block feasibility gate in the product specification.
2. Implement the pure core and the anchoring fixture matrix, including negative cases that must remain unresolved.
3. Fault-test storage: interruption before/after manifest replacement, missing/corrupt snapshots, lock contention, stale locks, two-process updates, same-note conflicts, disk errors, and newer schemas. Assert old durable records remain readable on pre-commit failure.
4. Exercise VS Code integration: creation on dirty buffers, restart, rename, undo/redo, external edits, branch switches, unsaved draft failures, and two windows. Verify source content and repository state remain unchanged by note operations.
5. Manually use Cote on an unfamiliar repository across two reading sessions. Confirm notes are recoverable and statuses understandable. Ship initially as a local development extension; marketplace publication is a separate task.

The original design phase delivered these specifications only. The subsequent local development implementation and its actual test results are recorded in [validation](validation.md).

## References

- [VS Code extension APIs, comments, storage, and document events](https://code.visualstudio.com/api/references/vscode-api)
- [jsdiff source and API documentation](https://github.com/kpdecker/jsdiff)
- [Git diff documentation](https://git-scm.com/docs/git-diff)
- [Git snapshots](https://git-scm.com/book/en/v2/Getting-Started-What-is-Git%3F)
- [Git apply and context](https://git-scm.com/docs/git-apply)
- [libgit2 diff APIs](https://libgit2.org/docs/reference/main/diff/index.html)
- [W3C text quote selectors](https://www.w3.org/TR/annotation-model/#text-quote-selector)
- [Neovim extended marks](https://neovim.io/doc/user/api#api-extmarks)
- [proper-lockfile locking and stale-lock behavior](https://github.com/moxystudio/node-proper-lockfile)
