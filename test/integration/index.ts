import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { makeThread, comment } from '../../src/ui/thread';
import type { Cote, NoteState } from '../../src/ui/application';
import { createAnchor } from '../../src/core/engine';
import { snapshot } from '../../src/core/text';

async function until(check: () => boolean, label: string) {
  const deadline = Date.now() + 6000;
  while (!check()) { if (Date.now() > deadline) throw new Error(`Timed out: ${label}`); await new Promise(r => setTimeout(r, 20)); }
}

export async function run() {
  const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
  await mkdir(root, { recursive: true });
  const file = path.join(root, 'sample.ts');
  const code = 'function check() {\n  return true;\n}\n';
  const body = '  indentation\n`backticks` **stars** [link](https://example.com)\n你好 👋 <script>alert(1)</script>';
  const extension = vscode.extensions.getExtension<Cote>('cote-local.cote')!;
  const app = await extension.activate();
  await app.ready;
  assert.ok(app.namespaces.length, 'Cote initialized at least one local namespace');
  if (process.env.COTE_TEST_PHASE === 'restart') {
    const doc = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(doc);
    await until(() => [...app.states.values()].some(s => !!s.thread && !s.busy), 'restored thread');
    const state = [...app.states.values()][0];
    assert.equal(state.note?.body, body);
    assert.equal(state.resolution.status, 'attached');
    assert.equal(state.thread!.collapsibleState, vscode.CommentThreadCollapsibleState.Collapsed);
    assert.equal(state.thread!.canReply, false);
    assert.equal(state.thread!.comments.length, 1);
    assert.equal(await readFile(file, 'utf8'), code);
    console.log('Cote restart test passed: durable plaintext restored collapsed at verified target.');
    return;
  }
  await writeFile(file, code);
  const doc = await vscode.workspace.openTextDocument(file);
  const editor = await vscode.window.showTextDocument(doc);
  const controller = vscode.comments.createCommentController('cote-spike', 'Cote feasibility');
  const thread = makeThread(controller, doc.uri, new vscode.Range(1, 2, 1, 14), body, true, true);
  assert.equal(thread.comments.length, 1);
  assert.equal(thread.comments[0].body, body);
  assert.equal(typeof thread.comments[0].body, 'string');
  assert.equal(thread.canReply, false);
  assert.equal(thread.comments[0].mode, vscode.CommentMode.Editing);
  thread.comments = [comment(body)];
  thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
  assert.equal(thread.collapsibleState, vscode.CommentThreadCollapsibleState.Collapsed);
  thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
  thread.range = new vscode.Range(2, 0, 2, 1);
  assert.equal(thread.range.start.line, 2);
  assert.equal(doc.isDirty, false);
  assert.equal(doc.getText(), code);
  thread.dispose();
  assert.equal(await readFile(file, 'utf8'), code);
  assert.equal(editor.document.isDirty, false);
  controller.dispose();
  console.log('Native Comments API spike passed: plaintext, edit mode, one comment, no replies, collapse, range updates, source isolation.');

  editor.selection = new vscode.Selection(1, 2, 1, 14);
  const state = (await app.add())!;
  assert.ok(state.thread); assert.equal(state.thread.canReply, false);
  await vscode.commands.executeCommand('cote.saveNote', { ...state.thread.comments[0], body });
  assert.equal(state.note?.body, body); assert.equal(state.note?.revision, 1);
  assert.equal(state.thread.comments[0].body, body);
  assert.equal(doc.isDirty, false); assert.equal(await readFile(file, 'utf8'), code);
  await vscode.commands.executeCommand('cote.editNote', { coteId: state.id });
  assert.equal(state.thread.comments[0].mode, vscode.CommentMode.Editing);
  await vscode.commands.executeCommand('cote.cancelNote', { coteId: state.id });
  assert.equal(state.thread.comments[0].body, body);
  await vscode.commands.executeCommand('cote.collapseNote', { coteId: state.id });
  assert.equal(state.thread.collapsibleState, vscode.CommentThreadCollapsibleState.Collapsed);
  assert.equal(doc.isDirty, false);

  // An adapter save failure must retain the draft and old durable body.
  const store = app.namespaces[0].store, save = store.save.bind(store);
  await vscode.commands.executeCommand('cote.editNote', { coteId: state.id });
  store.save = async () => { throw new Error('Simulated ENOSPC'); };
  try { await vscode.commands.executeCommand('cote.saveNote', { ...state.thread!.comments[0], body: 'pending draft' }); }
  finally { store.save = save; }
  assert.equal(state.note!.body, body); assert.equal(state.draft, 'pending draft');
  assert.ok(state.pending); assert.equal(state.editing, true);
  assert.equal((await store.list())[0].body, body);
  await state.pending!(); assert.equal(state.note!.body, 'pending draft');

  // Another writer changes the durable record while this editor holds a draft.
  await vscode.commands.executeCommand('cote.editNote', { coteId: state.id });
  await store.save({ note: { ...state.note!, body: 'other window' }, expectedRevision: state.note!.revision, snapshots: [] });
  await vscode.commands.executeCommand('cote.saveNote', { ...state.thread!.comments[0], body: 'conflicting draft' });
  assert.ok(state.pending); assert.equal(state.editing, true);
  assert.equal((await store.list())[0].body, 'other window');
  await vscode.commands.executeCommand('cote.cancelNote');
  await until(() => state.note?.body === 'other window', 'reload after conflict');
  await vscode.commands.executeCommand('cote.editNote', { coteId: state.id });
  await vscode.commands.executeCommand('cote.saveNote', { ...state.thread!.comments[0], body });
  assert.equal(state.note!.body, body);

  // Only the test edits source; note commands must preserve both content and dirty state.
  await editor.edit(edit => edit.insert(new vscode.Position(0, 0), '// added\n'));
  await until(() => state.resolution.status === 'attached' && state.resolution.location.range.start.line === 2, 'live shift');
  assert.equal(doc.isDirty, true);
  await editor.edit(edit => edit.insert(new vscode.Position(2, 9), '!!'));
  await until(() => state.resolution.status === 'needs-review', 'changed code status');
  await until(() => !state.busy, 'cache write');
  await vscode.commands.executeCommand('cote.editNote', { coteId: state.id });
  await vscode.commands.executeCommand('cote.saveNote', { thread: state.thread, text: body });
  assert.equal(state.resolution.status, 'needs-review', 'editing body must not accept code');
  assert.equal(doc.isDirty, true);
  await editor.edit(edit => edit.replace(new vscode.Range(0, 0, doc.lineCount - 1, 0), code));
  await until(() => state.resolution.status === 'attached' && state.resolution.location.range.start.line === 1, 'undo to accepted snapshot');
  await doc.save(); // Explicit test source action, never extension behavior.
  await until(() => !state.busy, 'settled writes');

  // Explicit acceptance preserves the creation anchor.
  const original = structuredClone(state.note!.original), captured = snapshot(doc.getText());
  const anchor = createAnchor({ workspaceId: state.accepted.workspaceId, relativePath: 'sample.ts',
    range: new vscode.Range(0, 0, 0, 18), snapshot: captured });
  await app.accept(state, anchor, captured);
  assert.deepEqual(state.note!.original, original);
  assert.deepEqual(state.note!.accepted.range, anchor.range);
  await app.accept(state, original, captured);

  // Editor file rename must move the one thread, retaining provenance.
  const renamed = vscode.Uri.file(path.join(root, 'renamed.ts'));
  const workspaceEdit = new vscode.WorkspaceEdit(); workspaceEdit.renameFile(doc.uri, renamed);
  assert.equal(await vscode.workspace.applyEdit(workspaceEdit), true);
  await until(() => state.thread?.uri.toString() === renamed.toString(), 'renamed thread');
  assert.equal(state.note!.original.relativePath, 'sample.ts');
  assert.equal(app.states.size, 1);
  const back = new vscode.WorkspaceEdit(); back.renameFile(renamed, vscode.Uri.file(file));
  await vscode.workspace.applyEdit(back);
  await until(() => state.thread?.uri.fsPath === file, 'renamed back');
  await until(() => !state.busy, 'rename settled');

  // Full deletion makes the saved note searchable without a speculative block.
  const reopened = await vscode.workspace.openTextDocument(file), currentEditor = await vscode.window.showTextDocument(reopened);
  await currentEditor.edit(edit => edit.delete(new vscode.Range(1, 2, 1, 14)));
  await until(() => state.resolution.status === 'unresolved' && !state.thread, 'deleted target');
  assert.equal(state.note!.body, body); assert.equal(state.note!.original.exact, 'return true;');
  await currentEditor.edit(edit => edit.replace(new vscode.Range(0, 0, reopened.lineCount - 1, 0), code));
  await reopened.save();
  await until(() => state.resolution.status === 'attached', 'target restored');

  // Creation on dirty buffers captures the dirty snapshot without saving code.
  await currentEditor.edit(edit => edit.insert(new vscode.Position(0, 0), '// dirty\n'));
  currentEditor.selection = new vscode.Selection(0, 0, 0, 8);
  const dirty = await vscode.commands.executeCommand<NoteState>('cote.addNote');
  await vscode.commands.executeCommand('cote.saveNote', { thread: dirty.thread, text: 'dirty note' });
  assert.equal(dirty.note!.original.exact, '// dirty'); assert.equal(reopened.isDirty, true);
  assert.equal(await readFile(file, 'utf8'), code);
  await app.remove(dirty, true); assert.equal(app.states.has(dirty.id), false);
  assert.equal(reopened.isDirty, true); assert.equal(await readFile(file, 'utf8'), code);
  await currentEditor.edit(edit => edit.delete(new vscode.Range(0, 0, 1, 0))); await reopened.save();
  await until(() => state.resolution.status === 'attached' && !state.busy, 'final state');
  await new Promise(r => setTimeout(r, 700));
  assert.equal((await app.namespaces[0].store.list()).length, 1);
  assert.equal(await readFile(file, 'utf8'), code);
  console.log('Cote integration passed: create/edit/cancel/collapse, dirty buffers, live edits, review status, acceptance, rename, deletion, recovery, source isolation.');
}
