# Implementation validation

Date: 2026-10-02 (Asia/Shanghai). Local development release, version 0.1.0.

## Automated checks

- 51 Node tests pass. The shared JSON fixture matrix exercises snapshot and live-event recovery, inserts/deletes around a selection, boundary affinity, partial changes, deletion, duplicate contexts, moves, discarded-only text, Unicode, CRLF/LF, blank-line anchors, rename evidence, undo/redo, and worker cancellation/timeouts.
- Storage tests exercise restart, exact plaintext, deduplication, revision conflicts, four independent writer processes, two processes contending for one note, active/stale locks, pre-commit disk failures, post-commit uncertainty, corrupt/missing snapshots, corrupt/newer manifests, namespace aliases, and manifest notifications.
- Git tests exercise operation without a repository, NUL-delimited unusual names, optional rename candidates, missing objects, and unchanged Git status after adapter calls.
- The extension-host integration test passes on VS Code 1.140.0/macOS. It covers native string comments, creation, native-comment Save arguments, edit/cancel/collapse, dirty buffers, target changes, body edits preserving warnings, explicit acceptance preserving provenance, editor renames, full deletion, recovery, source-byte/dirty-state isolation, retained drafts after simulated disk failure, and adapter handling of another writer’s revision conflict.
- The runner then launches a second VS Code process with the same isolated profile and workspace. The saved plaintext and verified target restore with one collapsed thread and replies disabled.
- Dependencies are pinned; the npm audit after updating `diff` to 8.0.4 reported zero vulnerabilities.

## Native comment feasibility and observed adjustments

An initial extension-host spike verified supported CommentController/CommentThread properties before the recovery and storage pipeline was added. Subsequent native UI checks used an isolated VS Code window, its command palette, and comment editor. Plaintext rendering, keyboard creation and Save, search across later body lines, edit/cancel, collapse, and restoration were checked. Source bytes were compared after note operations. No extension code uses internal DOM or proposed APIs.

The supported API has these limits; the product design adopts the following behavior:

1. **Draft keystrokes are not observable through the stable Comments API.** Empty input disables Save using VS Code’s comment context. Whitespace-only input is rejected on submission and remains in editing mode; it cannot be continuously disabled by an extension-owned whitespace check.
2. **Save for an existing editable comment receives the updated Comment body.** It does not use CommentReply.text. The implementation handles both contracts, and the integration test includes the native Comment shape.
3. **No stable direct-focus/reveal method exists on CommentThread in the minimum API.** Cote opens the source, reveals its range, and expands the block. The native edit mode focuses its input; Save uses the native shortcut. Cancel is available directly in the palette, avoiding dependence on Tab-key configuration.
4. **Thread URI is immutable.** An editor rename disposes the old thread and creates one at the verified new URI. Same-file edits update the existing range. An active draft is retained at its old block until Save/Cancel rather than discarding its input during a rename.
5. **Navigation/closing cannot be vetoed by a comments provider.** Cote-controlled navigation asks before discarding drafts. Ordinary source-editor navigation warns and retains the edit. A process crash, reload, or shutdown can lose an unpersisted draft.
6. **Modern local storage URIs may use `vscode-userdata:`.** On a verified local desktop host, Cote uses ExtensionContext.globalStoragePath, the API’s absolute local storage path, for atomic filesystem persistence and cross-process locks.

## Scope of evidence

The real restart test and storage concurrency tests are automated. Cross-window conflicts are fault-tested at the store boundary; two interactive user windows have not undergone an extended manual stress session. The UI was exercised across two isolated reading sessions on a source fixture, not a prolonged unfamiliar-repository study. Windows/Linux and VS Code 1.96 runtime checks are still needed before a broad release. Filesystem fault tests simulate failures around the commit point; they do not claim to simulate every power-loss behavior of every filesystem.

The original product, anchoring, and architecture documents remain the design reference. This implementation is intended for local development use and evaluation; Marketplace publication is a separate task.
