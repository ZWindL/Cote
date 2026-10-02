# Cote v1: product design

Status: implementation specification · 2026-09-19

Cote lets developers record their working understanding beside code without editing source files. V1 targets VS Code desktop and local filesystem workspaces. Notes contain plaintext and remain local, outside the repository.

The central principle is to **preserve notes reliably, and expose uncertainty about their location or continued relevance**. Location confidence does not establish that a note is factually correct.

Related specifications: [anchoring](anchoring-design.md) and [architecture](architecture.md).

## Reading and writing workflow

1. Select a range and invoke **Cote: Add Note** from the command palette or editor context menu. With an empty selection, target the current line excluding its line ending. A blank line creates a contextual, zero-length anchor.
2. Open a native VS Code comment block at that range in editing mode. The initial draft is local UI state; **Save** persists the note and anchor together. **Cancel** discards the draft. Empty input disables Save; whitespace-only input is rejected on submission and retained for editing. The stable Comments API does not expose draft keystrokes for continuous whitespace validation.
3. After save, show the plaintext note in its expanded block. Offer **Edit**, **Delete**, and **Collapse**; replies are disabled. Editing offers **Save** and **Cancel**. Cancel restores the last persisted text. Delete explicitly removes the note record; it never changes code.
4. Revisit notes through **Cote: Find Note**, a Quick Pick searchable by body and workspace-relative path. Each result includes status and the first line of the body. Selecting a located note opens its file, reveals the range, and expands the block.
5. For an unresolved note, open a read-only preview of its body, original excerpt, and reason. Offer **Reattach** and **Delete**, retaining access when the source file is missing.

On opening a file, restore notes collapsed to avoid displacing the reading position. Newly created, explicitly navigated, or reattached notes expand. Collapse state is session UI state, not note content. One note corresponds to one comment thread and one comment; multiple notes may share a range.

Provide **Cote: Reattach Note** to choose a note for the current selection/current line. Show the note and destination for explicit confirmation, then persist the new accepted anchor. Reattachment retains the original anchor for provenance. An attached note can also be reattached deliberately.

## Status and review

| Status | Meaning | Presentation and actions |
| --- | --- | --- |
| Attached | The accepted target is located without a detected target-text change. | Normal inline block; edit, delete, collapse, reattach. |
| Needs review | A defensible location remains, but the target text changed. | Inline block labeled “Code changed”; show accepted and current excerpts; offer **Confirm reviewed** or reattach. |
| Unresolved | No defensible unique location exists, or the file is unavailable. | Searchable entry with reason and original excerpt; no speculative inline block. |

**Confirm reviewed** explicitly accepts the current target and snapshot without rewriting the note body. Editing the body alone does not clear a location warning. Reattachment also accepts its new target. Neither action erases the original anchor. Restoring exact accepted content through undo or a branch switch may automatically restore Attached status.

When an operation cannot be persisted, show “Not saved” with the failure and **Retry**. Keep the draft or pending action in the current session and do not present it as durable. A pending deletion is not removed from the persisted list until it succeeds. Warn before discarding an unsaved note edit during navigation; a process crash can still lose an unpersisted draft.

## Initial boundaries

- Support named text files inside local workspace folders, including dirty buffers and untracked files. Require untitled buffers to be saved to a path before annotation; saving code is a user action, never an automatic consequence of adding a note.
- Treat each canonical workspace folder as its own note namespace. Separate clones and worktrees remain separate. Multiple workspace folders can be searched together.
- Work without Git. Git adds historical and rename evidence but never becomes the only copy of an anchor's source content.
- Exclude rich text, diagrams, collaboration, cloud sync, remote/virtual workspaces, dedicated commit-diff notes, automatic explanations, fuzzy relocation, cross-file symbol tracking, and Neovim implementation.
- Workspace moves, cross-clone migration, export/import, and simultaneous interoperability with a future Neovim client are deferred.

## Native comment-block validation gate

Before implementing the full storage and recovery pipeline, build a disposable integration spike against supported VS Code APIs. It must demonstrate:

- One editable note per native thread, with replies disabled after creation, and explicit Save/Cancel/Edit/Delete commands.
- Plaintext preservation for newlines, indentation, backticks, Markdown punctuation, Unicode, and HTML-looking strings. Use a string comment body; do not interpret note text as trusted Markdown or HTML.
- Keyboard-only creation, editing, save/cancel, navigation, collapse, and reattachment.
- Correct thread-range updates after document edits and file renames, without creating duplicate threads.
- Collapsed restoration and expanded navigation; status labels and unresolved previews remain discoverable.
- Adding, editing, deleting, and collapsing notes leaves source bytes, document dirty state, and repository contents unchanged.

If the supported widget API cannot satisfy a requirement, record the observed limitation and revise the design before shipping. Do not depend on VS Code internal DOM or proposed APIs silently.

Implementation findings and the adopted native-widget adjustments are recorded in [validation](validation.md). In particular, keyboard Cancel is available in the command palette, navigation uses source-range reveal plus expanded thread state, and draft warnings cannot veto VS Code shutdown.

## Product acceptance

A developer can annotate an unfamiliar file, restart VS Code, search their notes, and resume at the intended passage. After code changes, each note is either correctly located, visibly marked for review, or accessible as unresolved. No note disappears because its code disappeared. The detailed scenario matrix is in the anchoring specification.

## References

- [VS Code Comments API and comment thread interfaces](https://code.visualstudio.com/api/references/vscode-api#comments)
- [VS Code Quick Pick API](https://code.visualstudio.com/api/references/vscode-api#window.showQuickPick)
