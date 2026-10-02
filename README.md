# Cote

Local plaintext notes beside code, without editing source files. Cote is a VS Code desktop extension for named files in local workspace folders, including dirty and untracked files. Git is optional.

## Install or run

Install the generated `cote-0.1.0.vsix` using **Extensions: Install from VSIX…**, then open a local workspace. This is a local development release; it has not been published to the Marketplace.

To develop from source, use Node.js 22 or newer:

```sh
npm ci
npm run compile
```

Open this folder in VS Code and press **F5** to start the extension development host. Build an installable package with `npm run package`.

## Use

1. Select code and run **Cote: Add Note** from the command palette or editor context menu. With no selection, Cote targets the current line. The shortcut is **Cmd+Alt+N** on macOS, **Ctrl+Alt+N** elsewhere.
2. Write your note in the native comment editor. Use **Save** or **Cmd+Enter / Ctrl+Enter**. **Cancel Note Edit** discards the draft. Empty input disables Save; whitespace-only input is rejected when submitted.
3. Use **Cote: Find Note** to search the entire note body and workspace-relative path. Selecting a located note reveals its passage and expands its block. Restored notes start collapsed.
4. **Edit Note**, **Cancel Note Edit**, **Collapse Note**, **Delete Note**, **Reattach Note**, and **Show Note Details** are also available in the command palette, so these workflows are keyboard accessible.

One note is one thread with one plaintext comment. Replies are disabled. Markdown punctuation, HTML-looking text, Unicode, indentation, and newlines are kept as text.

| Status | What to do |
| --- | --- |
| Attached | The accepted target is located without a detected target-text change. This does not certify the explanation’s correctness. |
| Code changed | Open **Show Note Details** to compare accepted/current excerpts. **Confirm Reviewed** explicitly accepts the current code without changing the note body. |
| Unresolved | Find Note still lists the note. Its read-only preview retains the body, original excerpt, and reason. Select destination code and use **Reattach Note**, or explicitly delete the note. |

Reattachment shows the note and destination for confirmation. Review and reattachment preserve the original creation anchor. Editing the note body alone does not clear a code warning.

**Not saved** means an operation failed. The draft or pending action remains in this session; use **Retry Unsaved Action**. A revision conflict offers Reload or comparison with the latest body, followed by explicit overwrite. Pending deletions do not disappear from durable storage. Cote warns when navigating away from an active edit, but closing the process can lose unsaved drafts.

## Where notes live

**Cote: Help** shows the local extension storage path. Each canonical workspace-folder URI has its own SHA-256 namespace, a versioned `manifest.json`, and an immutable `snapshots/` directory. Symlink aliases share a namespace; clones and worktrees do not.

Snapshots contain **full editor-visible source text, including unsaved code**. Notes and snapshots remain in extension storage after source deletion. Snapshots are deduplicated and are not automatically garbage-collected, so storage grows over time. Back up the whole namespace if needed. There is no network sync or telemetry.

Cote never saves source documents, inserts source comments, applies patches, or runs Git write commands. Corrupt or newer-schema stores are retained and reported with their location instead of being silently reset.

## Validation

```sh
npm test                  # Core fixtures, Git, fault injection, cross-process storage
npm run test:integration  # Isolated VS Code lifecycle test, followed by a real restart
npm run package           # Compile, bundle runtime dependencies, generate VSIX
```

On macOS the integration runner uses the installed VS Code application. Set `COTE_VSCODE_EXECUTABLE` to another desktop executable, including on Windows/Linux. If no executable is supplied on other platforms, `@vscode/test-electron` downloads VS Code. Tests use temporary workspaces and profiles.

See [validation results and native-widget limits](docs/validation.md), [architecture](docs/architecture.md), and [language-neutral anchoring fixtures](test/fixtures/anchoring.json).

The implementation uses stable APIs typed against VS Code 1.96+. Runtime verification was performed on macOS with VS Code 1.140.0. Other platforms and minimum-version runtime testing remain release checks. Remote/virtual workspaces, cross-clone migration, fuzzy relocation, collaboration, and Neovim are outside v1.

## License

Cote is licensed under the [MIT License](LICENSE). Bundled dependencies retain their own licenses; see [third-party notices](THIRD_PARTY_NOTICES.md).
