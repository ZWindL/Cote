import { promises as fs, watch, FSWatcher } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import lockfile from 'proper-lockfile';
import { Note, Snapshot } from '../core/model';
import { hash, TextIndex, validateSnapshot, validRelativePath } from '../core/text';
import { validateAnchor } from '../core/engine';

type Manifest = { schemaVersion: 1; generation: number; workspaceId: string; canonicalUri: string; notes: Note[] };
export class ConflictError extends Error {
  constructor(readonly latest: Note | undefined) { super('This note changed in another window. Reload or explicitly overwrite the latest revision.'); }
}
export class StoreError extends Error {
  constructor(message: string, readonly location: string) { super(`${message} (storage: ${location})`); }
}
export class DurabilityError extends StoreError {
  constructor(location: string, readonly committed: Note | undefined) {
    super('Manifest committed, but directory flush failed; power-loss durability is uncertain', location);
  }
}
type FaultStage = 'before-snapshot-rename' | 'before-manifest-rename' | 'after-manifest-rename';
type StoreOptions = { fault?: (stage: FaultStage) => void | Promise<void>; lockTimeoutMs?: number };
const digest = /^[a-f0-9]{64}$/;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

export class LocalStore {
  readonly manifestPath: string;
  readonly snapshotsPath: string;
  private constructor(readonly directory: string, readonly workspaceId: string,
    readonly canonicalUri: string, readonly canonicalPath: string, private readonly options: StoreOptions) {
    this.manifestPath = path.join(directory, 'manifest.json');
    this.snapshotsPath = path.join(directory, 'snapshots');
  }
  static async open(storageRoot: string, folder: string, options: StoreOptions = {}): Promise<LocalStore> {
    const canonicalPath = await fs.realpath(folder), canonicalUri = pathToFileURL(canonicalPath).href;
    const workspaceId = hash(canonicalUri), directory = path.join(storageRoot, workspaceId);
    await fs.mkdir(path.join(directory, 'snapshots'), { recursive: true });
    const store = new LocalStore(directory, workspaceId, canonicalUri, canonicalPath, options);
    await store.manifest(); // Never repair or replace corrupt/newer data silently.
    return store;
  }
  private empty(): Manifest {
    return { schemaVersion: 1, generation: 0, workspaceId: this.workspaceId, canonicalUri: this.canonicalUri, notes: [] };
  }
  private validateNote(note: Note): void {
    if (!note || !uuid.test(note.id) || !Number.isInteger(note.revision) || note.revision < 0 ||
      typeof note.body !== 'string' || !note.body.trim() || !Number.isFinite(Date.parse(note.createdAt)) ||
      !Number.isFinite(Date.parse(note.updatedAt))) throw new StoreError('Invalid note record; store is read-only until repaired', this.directory);
    for (const anchor of [note.original, note.accepted]) {
      if (!anchor || anchor.workspaceId !== this.workspaceId || !validRelativePath(anchor.relativePath) ||
        !digest.test(anchor.snapshotId) || !anchor.range || !anchor.range.start || !anchor.range.end ||
        !['exact', 'prefix', 'suffix'].every(k => typeof anchor[k as 'exact'] === 'string'))
        throw new StoreError('Invalid anchor record; store is read-only until repaired', this.directory);
    }
    const r = note.resolution;
    if (note.pathHint && (!validRelativePath(note.pathHint.relativePath) || note.pathHint.evidence !== 'verified-rename'))
      throw new StoreError('Invalid recorded rename', this.directory);
    if (r && (!Array.isArray(r.evidence) || !r.evidence.every(e => typeof e === 'string') ||
      (r.status === 'unresolved' ? typeof r.reason !== 'string' :
        !['attached', 'needs-review'].includes(r.status) || !r.location || !validRelativePath(r.location.relativePath) ||
        !digest.test(r.location.snapshotId)))) throw new StoreError('Invalid resolution record', this.directory);
  }
  private async manifest(): Promise<Manifest> {
    let raw: string;
    try { raw = await fs.readFile(this.manifestPath, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return this.empty(); throw error; }
    let value: Manifest;
    try { value = JSON.parse(raw); } catch { throw new StoreError('Corrupt manifest; files have been retained', this.directory); }
    if (!value || value.schemaVersion !== 1) throw new StoreError('Unsupported schema version; store is read-only', this.directory);
    if (value.workspaceId !== this.workspaceId || value.canonicalUri !== this.canonicalUri ||
      !Number.isInteger(value.generation) || value.generation < 0 || !Array.isArray(value.notes))
      throw new StoreError('Invalid manifest envelope', this.directory);
    const ids = new Set<string>();
    for (const note of value.notes) { this.validateNote(note); if (ids.has(note.id)) throw new StoreError('Duplicate note IDs', this.directory); ids.add(note.id); }
    return value;
  }
  async list(workspaceId = this.workspaceId): Promise<Note[]> {
    if (workspaceId !== this.workspaceId) throw new StoreError('Workspace namespace mismatch', this.directory);
    return (await this.manifest()).notes;
  }
  async readSnapshot(id: string): Promise<Snapshot> {
    if (!digest.test(id)) throw new StoreError('Invalid snapshot ID', this.directory);
    const text = await fs.readFile(path.join(this.snapshotsPath, id), 'utf8'), value = { id, text };
    try { validateSnapshot(value); } catch { throw new StoreError(`Corrupt snapshot ${id}; files have been retained`, this.directory); }
    return value;
  }
  private async syncDirectory(directory: string): Promise<void> {
    let handle;
    try { handle = await fs.open(directory, 'r'); await handle.sync(); }
    catch (error) {
      if (!['EINVAL', 'ENOTSUP', 'EISDIR', ...(process.platform === 'win32' ? ['EPERM', 'EACCES'] : [])].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    } finally { await handle?.close(); }
  }
  private async writeTemporary(destination: string, text: string): Promise<string> {
    const temporary = `${destination}.${randomUUID()}.tmp`;
    const file = await fs.open(temporary, 'wx', 0o600);
    try { await file.writeFile(text, 'utf8'); await file.sync(); } catch (error) { await fs.unlink(temporary).catch(() => {}); throw error; }
    finally { await file.close(); }
    return temporary;
  }
  private async locked<T>(action: (assertLocked: () => void) => Promise<T>): Promise<T> {
    let compromised: Error | undefined;
    const release = await lockfile.lock(this.directory, { realpath: true, stale: 5000, update: 1000,
      retries: { retries: Math.floor((this.options.lockTimeoutMs ?? 5000) / 100), factor: 1, minTimeout: 100, maxTimeout: 100 },
      onCompromised: error => { compromised = error; } });
    try { return await action(() => { if (compromised) throw compromised; }); }
    finally { await release().catch(error => { if (!compromised) throw error; }); }
  }
  private async commit(manifest: Manifest, assertLocked: () => void, committed?: Note): Promise<void> {
    manifest.generation++;
    const temporary = await this.writeTemporary(this.manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    try {
      await this.options.fault?.('before-manifest-rename'); assertLocked();
      await fs.rename(temporary, this.manifestPath); // Commit point.
    } catch (error) { await fs.unlink(temporary).catch(() => {}); throw error; }
    try { await this.options.fault?.('after-manifest-rename'); await this.syncDirectory(this.directory); }
    catch { throw new DurabilityError(this.directory, committed); }
  }
  async save(input: { note: Note; expectedRevision: number | null; snapshots: Snapshot[] }): Promise<Note> {
    return this.locked(async assertLocked => {
      const manifest = await this.manifest(), existing = manifest.notes.find(n => n.id === input.note.id);
      if (input.expectedRevision === null ? !!existing : !existing || existing.revision !== input.expectedRevision)
        throw new ConflictError(existing);
      const note = structuredClone(input.note);
      if (existing && JSON.stringify(existing.original) !== JSON.stringify(note.original))
        throw new StoreError('Original anchor is immutable', this.directory);
      note.revision = (existing?.revision ?? 0) + 1;
      note.updatedAt = new Date().toISOString();
      if (existing) note.createdAt = existing.createdAt;
      this.validateNote(note);
      const incoming = new Map(input.snapshots.map(s => { validateSnapshot(s); return [s.id, s]; }));
      for (const snap of incoming.values()) {
        const destination = path.join(this.snapshotsPath, snap.id);
        try { await this.readSnapshot(snap.id); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          const temporary = await this.writeTemporary(destination, snap.text);
          try { await this.options.fault?.('before-snapshot-rename'); assertLocked(); await fs.rename(temporary, destination); }
          catch (failure) { await fs.unlink(temporary).catch(() => {}); throw failure; }
        }
      }
      await this.syncDirectory(this.snapshotsPath);
      for (const anchor of [note.original, note.accepted]) {
        const source = incoming.get(anchor.snapshotId) ?? await this.readSnapshot(anchor.snapshotId);
        validateAnchor(anchor, source);
      }
      if (note.resolution && note.resolution.status !== 'unresolved') {
        const source = incoming.get(note.resolution.location.snapshotId) ?? await this.readSnapshot(note.resolution.location.snapshotId);
        new TextIndex(source.text).offsets(note.resolution.location.range);
      }
      manifest.notes = manifest.notes.filter(n => n.id !== note.id).concat(note);
      await this.commit(manifest, assertLocked, note);
      return note;
    });
  }
  async delete(id: string, expectedRevision: number): Promise<void> {
    await this.locked(async assertLocked => {
      const manifest = await this.manifest(), existing = manifest.notes.find(n => n.id === id);
      if (!existing || existing.revision !== expectedRevision) throw new ConflictError(existing);
      manifest.notes = manifest.notes.filter(n => n.id !== id);
      await this.commit(manifest, assertLocked);
    });
  }
  observe(callback: () => void): { dispose(): void } {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const watcher: FSWatcher = watch(this.directory, (_event, filename) => {
      if (filename?.toString() !== 'manifest.json') return;
      clearTimeout(timer); timer = setTimeout(callback, 100);
    });
    watcher.on('error', callback);
    return { dispose() { clearTimeout(timer); watcher.close(); } };
  }
}
