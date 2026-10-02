import * as v from 'vscode';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Anchor, Candidate, Note, Resolution, Snapshot, unresolved } from '../core/model';
import { createAnchor, applyBufferChanges } from '../core/engine';
import { recover } from '../core/recovery';
import { snapshot, TextIndex, validRelativePath } from '../core/text';
import { ConflictError, DurabilityError, LocalStore } from '../storage/store';
import { captureGit, renameCandidates, observeGit } from '../git/adapter';
import { comment, makeThread } from './thread';

type Namespace = { folder: v.WorkspaceFolder; store: LocalStore };
export type NoteState = {
  id: string; namespace: Namespace; note?: Note; baseline: Snapshot; accepted: Anchor;
  resolution: Resolution; current?: Snapshot; thread?: v.CommentThread;
  editing: boolean; draft: string; draftRevision: number | null;
  pending?: () => Promise<void>; error?: string; busy: boolean;
  history: Map<string, Resolution>; timer?: ReturnType<typeof setTimeout>;
  epoch: number; abort?: AbortController; pathHint?: string;
};
type Payload = { thread?: v.CommentThread; comment?: v.Comment & { coteId?: string }; text?: string; body?: string | v.MarkdownString; coteId?: string };
const statusText = (r: Resolution) => r.status === 'unresolved' ? `Unresolved · ${r.reason.replace(/-/g, ' ')}`
  : r.status === 'attached' ? 'Attached' : 'Code changed';
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export class Cote implements v.Disposable {
  readonly controller = v.comments.createCommentController('cote', 'Cote');
  readonly states = new Map<string, NoteState>();
  readonly namespaces: Namespace[] = [];
  private readonly output = v.window.createOutputChannel('Cote');
  private readonly previews = new Map<string, string>();
  private readonly previewChanged = new v.EventEmitter<v.Uri>();
  private readonly resources: v.Disposable[] = [this.controller, this.output, this.previewChanged];
  private readonly buffers = new Map<string, { snapshot: Snapshot; version: number }>();
  private disposed = false;
  readonly ready: Promise<void>;

  constructor(private readonly context: v.ExtensionContext) {
    this.controller.options = { prompt: 'Local code note', placeHolder: 'Your working understanding…' };
    this.resources.push(v.workspace.registerTextDocumentContentProvider('cote-note', {
      onDidChange: this.previewChanged.event,
      provideTextDocumentContent: uri => this.previews.get(uri.toString()) ?? 'This note is no longer available.'
    }));
    const commands: Record<string, (arg?: Payload | v.CommentThread) => unknown> = {
      addNote: () => this.add(), findNote: () => this.find(),
      saveNote: arg => this.saveDraft(arg),
      cancelNote: arg => this.cancel(this.state(arg) ?? [...this.states.values()].find(s => s.editing || s.pending)),
      editNote: async arg => this.edit(await this.pickState(arg)),
      deleteNote: async arg => this.remove(await this.pickState(arg)),
      collapseNote: async arg => this.collapse(await this.pickState(arg)),
      reattachNote: async arg => this.reattach(await this.pickState(arg)),
      confirmReviewed: async arg => this.confirm(await this.pickState(arg)),
      previewNote: async arg => this.preview(await this.pickState(arg)),
      retry: async arg => { const s = await this.pickState(arg); if (s?.pending) await s.pending(); else if (s) await this.resolve(s); },
      help: () => this.help()
    };
    for (const [name, run] of Object.entries(commands)) this.resources.push(v.commands.registerCommand(`cote.${name}`,
      async arg => { await this.ready; try { return await run(arg); } catch (error) { this.report(error); } }));
    this.resources.push(v.workspace.onDidChangeTextDocument(e => this.changed(e)),
      v.workspace.onDidOpenTextDocument(doc => void this.opened(doc)),
      v.workspace.onDidCloseTextDocument(doc => {
        this.buffers.delete(doc.uri.toString());
        for (const s of this.forFile(doc.uri)) {
          if (!s.editing) { s.thread?.dispose(); s.thread = undefined; }
          void this.resolve(s);
        }
      }),
      v.window.onDidChangeActiveTextEditor(editor => {
        if (editor) void this.opened(editor.document);
        if (editor && ['file', 'cote-note'].includes(editor.document.uri.scheme) &&
          [...this.states.values()].some(s => s.editing && s.thread?.uri.toString() !== editor.document.uri.toString()))
          void v.window.showWarningMessage('Cote has an unsaved note edit. Return to its block to Save or Cancel.');
      }),
      v.workspace.onDidRenameFiles(e => void this.renamed(e)),
      v.workspace.onDidChangeWorkspaceFolders(() => void v.window.showInformationMessage('Reload this window to update Cote workspace namespaces.')));
    const watcher = v.workspace.createFileSystemWatcher('**/*');
    const changedFile = (uri: v.Uri) => {
      for (const s of this.forFile(uri)) void this.resolve(s);
    };
    this.resources.push(watcher, watcher.onDidChange(changedFile), watcher.onDidCreate(changedFile), watcher.onDidDelete(changedFile));
    this.ready = this.initialize();
  }

  private report(error: unknown) {
    this.output.appendLine(message(error));
    console.error('Cote:', message(error));
    void v.window.showErrorMessage(`Cote: ${message(error)}`, 'Show details').then(action => { if (action) this.output.show(); });
  }
  private async initialize() {
    if (v.env.remoteName || v.env.uiKind !== v.UIKind.Desktop ||
      !['file', 'vscode-userdata'].includes(this.context.globalStorageUri.scheme)) {
      this.report(new Error('V1 supports local desktop workspaces only.')); return;
    }
    for (const folder of v.workspace.workspaceFolders ?? []) {
      if (folder.uri.scheme !== 'file') continue;
      try {
        // Desktop VS Code may expose a vscode-userdata URI. globalStoragePath
        // remains the documented absolute local path for the same storage.
        const store = await LocalStore.open(this.context.globalStoragePath, folder.uri.fsPath);
        const namespace = { folder, store }; this.namespaces.push(namespace);
        await this.reload(namespace);
        this.resources.push(store.observe(() => void this.reload(namespace).catch(e => this.report(e))));
        void observeGit(folder.uri.fsPath, () => {
          // Files not currently open are checked on navigation or file events.
          for (const doc of v.workspace.textDocuments) for (const s of this.forFile(doc.uri))
            if (s.namespace === namespace) void this.resolve(s);
        }).then(watcher => { if (this.disposed) watcher.dispose(); else this.resources.push(watcher); });
      } catch (error) { this.report(error); }
    }
    for (const doc of v.workspace.textDocuments) await this.opened(doc, false);
    if (!this.context.globalState.get('cote.storageNotice')) {
      void v.window.showInformationMessage('Cote stores notes and full source snapshots locally outside your repository. Private code remains there after source deletion. See Cote: Help.');
      await this.context.globalState.update('cote.storageNotice', true);
    }
  }

  private async reload(namespace: Namespace) {
    if (this.disposed) return;
    const notes = await namespace.store.list(), ids = new Set(notes.map(n => n.id));
    for (const s of this.states.values()) if (s.namespace === namespace && s.note && !ids.has(s.id)) {
      if (s.editing || s.pending || s.busy) s.error = 'Deleted in another window. Your draft is retained.';
      else { this.disposeState(s); this.states.delete(s.id); }
    }
    for (const note of notes) {
      const existing = this.states.get(note.id);
      if (existing && (existing.note?.revision === note.revision || existing.busy)) continue;
      if (existing?.editing || existing?.pending) { existing.error = 'Changed in another window · Save will check the revision'; continue; }
      let baseline: Snapshot;
      try { baseline = await namespace.store.readSnapshot(note.accepted.snapshotId); }
      catch { baseline = { id: note.accepted.snapshotId, text: '' }; }
      const s: NoteState = existing ?? { id: note.id, namespace, baseline, accepted: note.accepted,
        resolution: note.resolution ?? unresolved('not-yet-checked'), editing: false, draft: '', draftRevision: note.revision,
        busy: false, history: new Map(), epoch: 0 };
      s.note = note; s.accepted = note.accepted; s.baseline = baseline;
      s.pathHint = note.pathHint?.relativePath;
      s.resolution = note.resolution ?? unresolved('not-yet-checked');
      s.history.clear(); this.states.set(note.id, s);
      // Cached locations must be verified before any thread is restored.
      if (existing) await this.resolve(s);
    }
  }
  private relative(ns: Namespace, uri: v.Uri): string | undefined {
    if (uri.scheme !== 'file') return;
    const relative = path.relative(ns.folder.uri.fsPath, uri.fsPath).split(path.sep).join('/');
    return validRelativePath(relative) ? relative : undefined;
  }
  private currentPath(s: NoteState): string {
    return s.pathHint ?? (s.resolution.status !== 'unresolved' ? s.resolution.location.relativePath : s.accepted.relativePath);
  }
  private storedPath(s: NoteState): Note['pathHint'] {
    return s.pathHint && s.pathHint !== s.accepted.relativePath
      ? { relativePath: s.pathHint, evidence: 'verified-rename' } : undefined;
  }
  private forFile(uri: v.Uri): NoteState[] {
    return [...this.states.values()].filter(s => {
      const relative = this.relative(s.namespace, uri);
      return relative && (relative === this.currentPath(s) || relative === s.accepted.relativePath);
    });
  }
  private async readCandidate(s: NoteState, relativePath: string, pathEvidence: string[] = []): Promise<Candidate | undefined> {
    if (!validRelativePath(relativePath)) return;
    const file = v.Uri.joinPath(s.namespace.folder.uri, relativePath);
    try {
      const real = await fs.realpath(file.fsPath);
      if (!validRelativePath(path.relative(s.namespace.store.canonicalPath, real).split(path.sep).join('/'))) return;
      const doc = v.workspace.textDocuments.find(d => d.uri.toString() === file.toString());
      const text = doc ? doc.getText() : (await v.workspace.openTextDocument(file)).getText();
      return { relativePath, snapshot: snapshot(text), pathEvidence };
    } catch { return undefined; }
  }

  async resolve(s: NoteState, persist = true): Promise<void> {
    if (s.busy || this.disposed) return;
    const epoch = ++s.epoch, revision = s.note?.revision;
    s.abort?.abort(); const abort = s.abort = new AbortController();
    const relative = this.currentPath(s);
    const candidate = await this.readCandidate(s, relative, relative !== s.accepted.relativePath ? ['verified-rename'] : []);
    const candidates: Candidate[] = candidate ? [candidate] : [];
    if (!candidate && relative !== s.accepted.relativePath) {
      const original = await this.readCandidate(s, s.accepted.relativePath); if (original) candidates.push(original);
    }
    if (!candidates.length) for (const rename of await renameCandidates(s.namespace.folder.uri.fsPath, s.accepted.git)) {
      const value = await this.readCandidate(s, rename, ['git-rename-candidate']); if (value) candidates.push(value);
    }
    if (epoch !== s.epoch) return;
    const cached = candidate ? s.history.get(candidate.snapshot.id) ?? s.note?.resolution : undefined;
    const validCache = s.baseline.id === snapshot(s.baseline.text).id && cached && cached.status !== 'unresolved' && candidate &&
      cached.location.snapshotId === candidate.snapshot.id && cached.location.relativePath === candidate.relativePath;
    const result = validCache ? structuredClone(cached)
      : await recover({ accepted: s.accepted, baseline: s.baseline, candidates }, abort.signal);
    if (epoch !== s.epoch || s.note?.revision !== revision || this.disposed) return;
    const target = result.status === 'unresolved' ? candidates[0] : candidates.find(c => c.relativePath === result.location.relativePath);
    if (target) {
      const doc = v.workspace.textDocuments.find(d => d.uri.fsPath === path.join(s.namespace.folder.uri.fsPath, target.relativePath));
      if (doc && snapshot(doc.getText()).id !== target.snapshot.id) { void this.resolve(s, persist); return; }
    }
    s.resolution = result; s.current = target?.snapshot;
    if (result.status !== 'unresolved') s.pathHint = result.location.relativePath;
    this.remember(s); this.render(s);
    if (persist) this.scheduleCache(s);
  }
  private async opened(doc: v.TextDocument, wait = true) {
    if (wait) await this.ready;
    if (doc.uri.scheme !== 'file' || this.disposed) return;
    this.buffers.set(doc.uri.toString(), { snapshot: snapshot(doc.getText()), version: doc.version });
    await Promise.all(this.forFile(doc.uri).map(s => this.resolve(s)));
  }
  private changed(event: v.TextDocumentChangeEvent) {
    if (!event.contentChanges.length || event.document.uri.scheme !== 'file') return;
    const key = event.document.uri.toString(), previous = this.buffers.get(key), after = snapshot(event.document.getText());
    this.buffers.set(key, { snapshot: after, version: event.document.version });
    for (const s of this.forFile(event.document.uri)) {
      s.epoch++; s.abort?.abort();
      if (!previous || event.document.version !== previous.version + 1 || !s.current || s.current.id !== previous.snapshot.id) {
        void this.resolve(s); continue;
      }
      s.resolution = s.history.get(after.id) ?? applyBufferChanges({ accepted: s.accepted, baseline: s.baseline,
        before: previous.snapshot, after, previous: s.resolution,
        edits: event.contentChanges.map(c => ({ range: c.range, text: c.text })) });
      s.current = after; this.remember(s); this.render(s); this.scheduleCache(s);
    }
  }
  private remember(s: NoteState) {
    if (s.current) s.history.set(s.current.id, structuredClone(s.resolution));
    while (s.history.size > 32) s.history.delete(s.history.keys().next().value!);
  }
  private render(s: NoteState, expanded?: boolean) {
    if (s.resolution.status === 'unresolved') {
      if (s.editing && s.thread) { s.thread.label = `Cote · ${statusText(s.resolution)} · Unsaved draft`; return; }
      s.thread?.dispose(); s.thread = undefined; return;
    }
    const uri = v.Uri.joinPath(s.namespace.folder.uri, s.resolution.location.relativePath), r = s.resolution.location.range;
    const range = new v.Range(r.start.line, r.start.character, r.end.line, r.end.character);
    if (s.thread && s.thread.uri.toString() !== uri.toString()) {
      if (s.editing) { s.thread.label = 'Cote · File renamed · Save or Cancel draft'; return; }
      s.thread.dispose(); s.thread = undefined;
    }
    if (!s.thread) s.thread = makeThread(this.controller, uri, range, s.note?.body ?? s.draft, s.editing, expanded ?? false);
    else s.thread.range = range;
    s.thread.contextValue = s.error ? 'coteError' : s.editing ? 'coteEditing' : s.resolution.status === 'needs-review' ? 'coteReview' : 'cote';
    s.thread.label = `Cote · ${statusText(s.resolution)}${s.error ? ' · Not saved' : s.editing ? ' · Unsaved draft' : ''}`;
    if (!s.editing) s.thread.comments = [Object.assign(comment(s.note?.body ?? s.draft), { coteId: s.id })];
    else if (!(s.thread.comments[0] as Payload)?.coteId) s.thread.comments = [Object.assign(comment(s.draft, true), { coteId: s.id })];
    if (expanded !== undefined) s.thread.collapsibleState = expanded ? v.CommentThreadCollapsibleState.Expanded : v.CommentThreadCollapsibleState.Collapsed;
  }
  private scheduleCache(s: NoteState) {
    clearTimeout(s.timer);
    if (!s.note || s.editing || s.pending) return;
    s.timer = setTimeout(() => void this.cache(s), 500);
  }
  private async cache(s: NoteState) {
    if (!s.note || s.busy || s.editing) return;
    if (JSON.stringify(s.note.resolution) === JSON.stringify(s.resolution) &&
      JSON.stringify(s.note.pathHint) === JSON.stringify(this.storedPath(s))) return;
    const proposal = { ...s.note, resolution: structuredClone(s.resolution), pathHint: this.storedPath(s) }, current = s.current;
    s.busy = true;
    try {
      s.note = await s.namespace.store.save({ note: proposal, expectedRevision: proposal.revision, snapshots: current ? [current] : [] });
      s.error = undefined; s.pending = undefined;
    } catch (error) {
      if (error instanceof ConflictError) {
        s.busy = false; s.pending = undefined; s.error = undefined;
        await this.reload(s.namespace); return;
      }
      if (error instanceof DurabilityError && error.committed) { s.note = error.committed; this.report(error); }
      else this.failed(s, error, () => this.cache(s));
    } finally { s.busy = false; }
    if (!s.pending) this.scheduleCache(s);
  }

  private async target() {
    const editor = v.window.activeTextEditor;
    if (!editor || editor.document.isUntitled || editor.document.uri.scheme !== 'file') throw new Error('Save the text file to a local workspace path before adding a note.');
    const namespace = this.namespaces.find(n => v.workspace.getWorkspaceFolder(editor.document.uri)?.uri.toString() === n.folder.uri.toString());
    if (!namespace) throw new Error('Open this file inside a local workspace folder.');
    const relativePath = this.relative(namespace, editor.document.uri)!;
    const real = await fs.realpath(editor.document.uri.fsPath);
    if (!validRelativePath(path.relative(namespace.store.canonicalPath, real).split(path.sep).join('/')))
      throw new Error('Files resolving outside this workspace are unsupported.');
    const range = editor.selection.isEmpty ? editor.document.lineAt(editor.selection.active.line).range : editor.selection;
    const captured = snapshot(editor.document.getText());
    const anchor = createAnchor({ workspaceId: namespace.store.workspaceId, relativePath, range, snapshot: captured });
    return { editor, namespace, captured, anchor, version: editor.document.version };
  }
  async add(): Promise<NoteState | undefined> {
    if (!await this.leaveDrafts()) return;
    const target = await this.target(), id = randomUUID();
    const s: NoteState = { id, namespace: target.namespace, baseline: target.captured, accepted: target.anchor,
      current: target.captured, resolution: { status: 'attached', location: { relativePath: target.anchor.relativePath,
        range: target.anchor.range, snapshotId: target.captured.id }, evidence: ['identical-snapshot'] },
      editing: true, draft: '', draftRevision: null, busy: false, history: new Map(), epoch: 0 };
    this.states.set(id, s); this.remember(s); this.render(s, true);
    this.buffers.set(target.editor.document.uri.toString(), { snapshot: target.captured, version: target.version });
    void captureGit(target.namespace.folder.uri.fsPath, target.editor.document.uri.fsPath).then(git => {
      if (!s.note && !s.busy && git) s.accepted.git = git;
    });
    return s;
  }
  private state(arg?: Payload | v.CommentThread): NoteState | undefined {
    if (!arg) return;
    const p = arg as Payload, id = p.coteId ?? p.comment?.coteId;
    if (id) return this.states.get(id);
    return [...this.states.values()].find(s => s.thread === (p.thread ?? arg));
  }
  private async pickState(arg?: Payload | v.CommentThread): Promise<NoteState | undefined> {
    const direct = this.state(arg); if (direct) return direct;
    return (await v.window.showQuickPick([...this.states.values()].map(s => ({
      label: (s.note?.body ?? s.draft).split(/\r?\n/)[0] || 'Unsaved draft',
      description: `${s.namespace.folder.name}/${this.currentPath(s)}`, detail: statusText(s.resolution), state: s
    })), { title: 'Cote: Choose Note', matchOnDescription: true, matchOnDetail: true }))?.state;
  }
  private async leaveDrafts(except?: NoteState): Promise<boolean> {
    const drafts = [...this.states.values()].filter(s => s !== except && (s.editing || s.pending));
    if (!drafts.length) return true;
    if (await v.window.showWarningMessage('Cote has unsaved edits or pending actions. Discard them to continue?', { modal: true }, 'Discard') !== 'Discard') return false;
    for (const s of drafts) this.cancel(s);
    return true;
  }
  private async saveDraft(arg?: Payload | v.CommentThread) {
    const s = this.state(arg);
    // Comment edit actions receive the Comment with an updated body. Initial
    // thread-reply actions use CommentReply.text. Support both stable contracts.
    const p = arg as Payload | undefined, body = p?.text ?? p?.body;
    if (!s || typeof body !== 'string') {
      void v.window.showInformationMessage('Use Save in the note editor (Tab to its Save button, then Enter).'); return;
    }
    s.draft = body;
    if (!s.draft.trim()) {
      this.restoreEditor(s);
      void v.window.showWarningMessage('A note cannot be empty or whitespace only.'); return;
    }
    await this.writeDraft(s);
  }
  private restoreEditor(s: NoteState) {
    if (s.editing && s.thread) s.thread.comments = [Object.assign(comment(s.draft, true), { coteId: s.id })];
  }
  private async writeDraft(s: NoteState) {
    if (s.busy) return;
    s.busy = true; clearTimeout(s.timer);
    const now = new Date().toISOString();
    const proposal: Note = s.note ? { ...s.note, body: s.draft, resolution: s.resolution, pathHint: this.storedPath(s) } : {
      id: s.id, revision: 0, body: s.draft, createdAt: now, updatedAt: now,
      original: structuredClone(s.accepted), accepted: structuredClone(s.accepted), resolution: s.resolution, pathHint: this.storedPath(s) };
    try {
      s.note = await s.namespace.store.save({ note: proposal, expectedRevision: s.draftRevision,
        snapshots: [s.baseline, ...(s.current ? [s.current] : [])] });
      s.editing = false; s.error = undefined; s.pending = undefined; s.draftRevision = s.note.revision;
      this.render(s, true);
    } catch (error) {
      if (error instanceof DurabilityError && error.committed) {
        s.note = error.committed; s.editing = false; s.pending = undefined; s.error = undefined;
        this.render(s, true); this.report(error);
      } else this.failed(s, error, () => this.writeDraft(s));
    } finally { s.busy = false; }
    if (!s.editing) this.scheduleCache(s);
  }
  private failed(s: NoteState, error: unknown, retry: () => Promise<void>) {
    s.error = message(error); s.pending = retry;
    this.restoreEditor(s);
    if (s.thread) { s.thread.label = 'Cote · Not saved'; s.thread.contextValue = 'coteError'; }
    this.output.appendLine(s.error);
    if (error instanceof ConflictError) {
      void v.window.showErrorMessage(`Cote · Not saved: ${s.error}`, 'Reload', 'Compare latest').then(async action => {
        if (action === 'Reload') { this.cancel(s); await this.reload(s.namespace); }
        if (action === 'Compare latest') await this.conflict(s, error.latest);
      });
    } else void v.window.showErrorMessage(`Cote · Not saved: ${s.error}`, 'Retry').then(async answer => { if (answer) await retry(); });
  }
  private async conflict(s: NoteState, latest?: Note) {
    await this.showText(`/${s.id}/conflict.txt`, `YOUR DRAFT\n${s.draft}\n\nLATEST DURABLE NOTE\n${latest?.body ?? '(deleted)'}\n\n${s.error}`);
    if (!s.editing) return;
    if (await v.window.showWarningMessage('Overwrite the latest body with your draft after comparing?', { modal: true }, 'Overwrite body') !== 'Overwrite body') return;
    // Explicit body overwrite retains the newest anchors and still uses a revision check.
    if (latest) { s.note = latest; s.accepted = latest.accepted;
      s.baseline = await s.namespace.store.readSnapshot(latest.accepted.snapshotId); s.draftRevision = latest.revision;
      s.pathHint = latest.pathHint?.relativePath; s.resolution = latest.resolution ?? unresolved('not-yet-checked'); s.history.clear();
    } else { s.note = undefined; s.draftRevision = null; }
    s.pending = undefined; await this.resolve(s, false); await this.writeDraft(s);
  }
  private cancel(s?: NoteState) {
    if (!s || s.busy) return;
    s.editing = false; s.pending = undefined; s.error = undefined;
    if (!s.note) { this.disposeState(s); this.states.delete(s.id); }
    else { s.draft = s.note.body; this.render(s); void this.reload(s.namespace).catch(e => this.report(e)); }
  }
  private async edit(s?: NoteState) {
    if (!s?.note || s.busy || s.editing || !await this.leaveDrafts(s)) return;
    await this.resolve(s, false);
    if (s.resolution.status === 'unresolved') { await this.preview(s); return; }
    await this.navigate(s);
    s.editing = true; s.draft = s.note.body; s.draftRevision = s.note.revision;
    this.render(s, true); s.thread!.comments = [Object.assign(comment(s.draft, true), { coteId: s.id })];
  }
  async remove(s?: NoteState, confirmed = false) {
    if (!s || s.busy) return;
    if (!s.note) { this.cancel(s); return; }
    if (!confirmed && await v.window.showWarningMessage(`Delete this Cote note?\n${s.note.body}`, { modal: true }, 'Delete') !== 'Delete') return;
    const revision = s.note.revision;
    const perform = async () => {
      if (s.busy) return; s.busy = true; clearTimeout(s.timer);
      try { await s.namespace.store.delete(s.id, revision); this.disposeState(s); this.states.delete(s.id); }
      catch (error) {
        if (error instanceof DurabilityError) { this.disposeState(s); this.states.delete(s.id); this.report(error); }
        else this.failed(s, error, perform);
      } finally { s.busy = false; }
    }; await perform();
  }
  private collapse(s?: NoteState) { if (s?.thread) s.thread.collapsibleState = v.CommentThreadCollapsibleState.Collapsed; }
  private async find() {
    if (!await this.leaveDrafts()) return;
    const states = [...this.states.values()].filter(s => s.note);
    for (let i = 0; i < states.length; i += 2) await Promise.all(states.slice(i, i + 2).map(s => this.resolve(s, false)));
    const selected = await v.window.showQuickPick(states.map(s => ({
      label: s.note!.body.split(/\r?\n/)[0], description: `${statusText(s.resolution)} · ${s.namespace.folder.name}/${this.currentPath(s)}`,
      detail: s.note!.body.replace(/\r?\n/g, ' '), state: s
    })), { title: 'Cote: Find Note', placeHolder: 'Search note text or workspace path', matchOnDescription: true, matchOnDetail: true });
    if (selected) await this.navigate(selected.state);
  }
  private async navigate(s: NoteState) {
    if (s.resolution.status === 'unresolved') { await this.preview(s); return; }
    const location = s.resolution.location, doc = await v.workspace.openTextDocument(v.Uri.joinPath(s.namespace.folder.uri, location.relativePath));
    const editor = await v.window.showTextDocument(doc), r = location.range;
    const range = new v.Range(r.start.line, r.start.character, r.end.line, r.end.character);
    editor.selection = new v.Selection(range.start, range.end);
    editor.revealRange(range, v.TextEditorRevealType.InCenterIfOutsideViewport); this.render(s, true);
  }
  private async showText(name: string, text: string) {
    const uri = v.Uri.from({ scheme: 'cote-note', path: name });
    this.previews.set(uri.toString(), text); this.previewChanged.fire(uri);
    await v.window.showTextDocument(await v.workspace.openTextDocument(uri), { preview: true });
  }
  private async preview(s?: NoteState) {
    if (!s) return;
    const original = s.note?.original ?? s.accepted;
    const current = s.current && s.resolution.status !== 'unresolved'
      ? new TextIndex(s.current.text).selected(s.resolution.location.range) : '(no verified location)';
    await this.showText(`/${s.id}/note.txt`, `${statusText(s.resolution)}\n${s.namespace.folder.name}/${this.currentPath(s)}\n\nNOTE\n${s.note?.body ?? s.draft}\n\nORIGINAL EXCERPT\n${original.exact}\n\nACCEPTED EXCERPT\n${s.accepted.exact}\n\nCURRENT EXCERPT\n${current}\n\n${s.error ?? ''}`);
    if (s.resolution.status === 'unresolved') void v.window.showInformationMessage('Cote note is unresolved. Select destination code and use Reattach Note.', 'Reattach', 'Delete').then(async choice => {
      try {
        if (choice === 'Delete') await this.remove(s);
        if (choice === 'Reattach') {
          const selected = await v.window.showOpenDialog({ defaultUri: s.namespace.folder.uri, canSelectMany: false,
            canSelectFiles: true, canSelectFolders: false, openLabel: 'Choose destination file' });
          if (selected?.[0]) {
            await v.window.showTextDocument(await v.workspace.openTextDocument(selected[0]));
            await this.reattach(s);
          }
        }
      } catch (error) { this.report(error); }
    });
  }
  private async reattach(s?: NoteState) {
    if (!s?.note || !await this.leaveDrafts()) return;
    const target = await this.target();
    if (target.namespace !== s.namespace) throw new Error('Reattach within the note’s original workspace folder.');
    if (await v.window.showInformationMessage(`Reattach this note?\n${s.note.body}\n\nDestination: ${target.anchor.relativePath}:${target.anchor.range.start.line + 1}\n${target.anchor.exact}`, { modal: true }, 'Reattach') !== 'Reattach') return;
    target.anchor.git = await captureGit(target.namespace.folder.uri.fsPath, target.editor.document.uri.fsPath);
    if (target.editor.document.version !== target.version) throw new Error('Destination changed during confirmation. Select it again.');
    await this.accept(s, target.anchor, target.captured);
  }
  private async confirm(s?: NoteState) {
    if (!s?.note || s.editing || !await this.leaveDrafts(s)) return;
    await this.resolve(s, false);
    if (s.resolution.status !== 'needs-review' || !s.current) return;
    await this.preview(s);
    if (await v.window.showInformationMessage('Accept the current code excerpt as reviewed? The note body stays the same.', { modal: true }, 'Confirm reviewed') !== 'Confirm reviewed') return;
    const current = await this.readCandidate(s, s.resolution.location.relativePath);
    if (!current || current.snapshot.id !== s.current.id) throw new Error('Code changed during review. Review the current excerpt again.');
    const anchor = createAnchor({ workspaceId: s.namespace.store.workspaceId, relativePath: current.relativePath,
      range: s.resolution.location.range, snapshot: current.snapshot });
    await this.accept(s, anchor, current.snapshot);
  }
  async accept(s: NoteState, anchor: Anchor, captured: Snapshot) {
    if (!s.note || s.busy) return;
    const revision = s.note.revision;
    const proposal = { ...s.note, accepted: anchor, pathHint: undefined, resolution: { status: 'attached' as const,
      location: { relativePath: anchor.relativePath, range: anchor.range, snapshotId: captured.id }, evidence: ['explicit-acceptance'] } };
    const perform = async () => {
      if (s.busy) return; s.busy = true; clearTimeout(s.timer);
      try {
        try { s.note = await s.namespace.store.save({ note: proposal, expectedRevision: revision, snapshots: [captured] }); }
        catch (error) { if (error instanceof DurabilityError && error.committed) { s.note = error.committed; this.report(error); } else throw error; }
        s.accepted = anchor; s.baseline = captured; s.current = captured; s.resolution = proposal.resolution;
        s.pathHint = anchor.relativePath; s.error = undefined; s.pending = undefined; s.history.clear();
        s.busy = false; await this.resolve(s, false); this.render(s, true); await this.navigate(s);
      } catch (error) { this.failed(s, error, perform); }
      finally { s.busy = false; }
    }; await perform();
  }
  private async renamed(event: v.FileRenameEvent) {
    await this.ready;
    for (const { oldUri, newUri } of event.files) for (const s of this.states.values()) {
      const old = this.relative(s.namespace, oldUri), current = this.currentPath(s);
      if (!old || (old !== current && !current.startsWith(old + '/'))) continue;
      const destination = this.relative(s.namespace, newUri);
      if (!destination) { s.resolution = unresolved('outside-workspace'); this.render(s); continue; }
      s.pathHint = destination + current.slice(old.length); s.history.clear(); await this.resolve(s);
    }
  }
  private help() {
    return this.showText('/help.txt', `COTE — LOCAL CODE NOTES\n\nSelect code, then Cote: Add Note. An empty selection targets the current line.\nType plaintext in the native editor. Tab to Save or Cancel and press Enter.\nCote: Find Note searches the complete body and path.\nEdit, Collapse, Reattach, Confirm Reviewed and Delete are available from the command palette.\nCode changed: inspect accepted/current excerpts with Cote: Show Note Details, then Confirm Reviewed or Reattach.\nUnresolved notes remain searchable after the file disappears.\n\nStorage: ${this.context.globalStorageUri.fsPath}\nNotes and full editor-visible snapshots (including unsaved code) remain here after source deletion.\nSnapshots are deduplicated but never automatically collected, so disk use grows.\nCote does not modify or save source files, sync, or send telemetry.\nV1 supports named text files inside local workspace folders.\n\nNative widget limits: live draft text is available to Cote on Save; whitespace-only Save is rejected then.\nDraft warnings are conservative. Closing VS Code can lose an unpersisted draft.\nFind Note reveals the range and expands its block; direct comment-editor focus is not a stable API.\n`);
  }
  private disposeState(s: NoteState) { clearTimeout(s.timer); s.abort?.abort(); s.thread?.dispose(); s.thread = undefined; }
  dispose() { this.disposed = true; for (const s of this.states.values()) this.disposeState(s); this.resources.forEach(d => d.dispose()); }
}
