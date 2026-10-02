import * as vscode from 'vscode';

export function comment(body: string, editing = false): vscode.Comment {
  return { body, author: { name: 'Cote' },
    mode: editing ? vscode.CommentMode.Editing : vscode.CommentMode.Preview,
    contextValue: editing ? 'coteEditing' : 'coteSaved' };
}

export function makeThread(controller: vscode.CommentController, uri: vscode.Uri,
  range: vscode.Range, body: string, editing = false, expanded = false): vscode.CommentThread {
  const thread = controller.createCommentThread(uri, range, [comment(body, editing)]);
  thread.canReply = false;
  thread.contextValue = 'cote';
  thread.label = editing ? 'Cote · Unsaved draft' : 'Cote · Attached';
  thread.collapsibleState = expanded ? vscode.CommentThreadCollapsibleState.Expanded
    : vscode.CommentThreadCollapsibleState.Collapsed;
  return thread;
}
