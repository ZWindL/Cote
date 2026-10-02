# Cote v1: anchoring design

Status: implementation specification · 2026-09-19

This document defines how Cote preserves the relationship between plaintext notes and working files. See [product behavior](product-design.md) and [interfaces and persistence](architecture.md).

## What Git provides

Git conceptually stores filesystem snapshots, not permanent line identities. A diff computes a correspondence between two contents. Rename detection infers similarity between deleted and added paths; it does not establish a stable file identity. Patch application uses context to locate changes even when line numbers shift. None of these operations proves that a passage still means the same thing.

Cote will reuse text comparison and optional Git rename information, but implement its own confidence and review rules. It never applies a patch to source code to relocate a note. Git blame is not an anchor identifier: attribution can change and it does not identify a user's selected range uniquely.

## Anchor and coordinate model

An anchor contains the workspace identity, relative path, half-open range, exact selected text, up to three complete context lines before and after the range, and a reference to an immutable source snapshot. Include partial boundary-line text in the prefix/suffix so mid-line selections have context. Store optional repository-relative path and HEAD revision as supplemental Git metadata.

Snapshots preserve the exact editor-visible text at capture, including unsaved content and line endings. They are not promised to preserve a source file's original byte encoding. A Git commit must never replace this snapshot: HEAD may describe different content. The snapshot's content hash identifies it within Cote's store independently of Git object hashes.

Maintain three distinct concepts:

- **Original anchor:** immutable provenance from note creation.
- **Accepted anchor:** the baseline for judging target changes, initially the original; replaced only by explicit review confirmation or reattachment.
- **Current resolution:** the most recent verified location/status for a specific target snapshot, plus evidence. It is a cache and must be revalidated if the content changes.

Use zero-based line numbers and UTF-16 code-unit columns, with half-open ranges throughout the persisted model and core API. Lines exclude their terminator. End-of-file positions are valid; positions between the CR and LF in CRLF are not. Adapters must not split a Unicode surrogate pair. For VS Code these units align with Position/Range; Neovim must convert UTF-8 byte columns to/from UTF-16 against the exact line text. Never treat bytes, code points, grapheme clusters, and UTF-16 units as interchangeable.

Keep LF and CRLF distinct in snapshots and offset calculation. During relocation, a line-ending-only conversion may be mapped using logical lines with terminators separated; verify that all non-terminator text is identical and return explicit `line-endings-only` evidence. Do not normalize whitespace or identifiers to manufacture matches.

## Resolution procedure

Resolution consumes the accepted anchor and exact current content; it may also use a previously verified snapshot/location as an additional mapping step. Always compare the resulting target to the accepted target before deciding Attached versus Needs review.

1. **Select the file.** Prefer its existing recorded path. Use a recorded editor rename event when available. If the path is absent, optionally obtain Git rename candidates and validate their content. An existing unrelated replacement at the same path is not sufficient evidence. Missing paths without a verified candidate remain unresolved.
2. **Identical snapshot.** Restore the baseline range, validating bounds and exact text. An exact accepted snapshot restores Attached even after an earlier unresolved state.
3. **Map differences.** Use jsdiff line changes to find unchanged spans; refine changed regions with character changes where necessary. An anchor wholly inside an unchanged, unambiguous span can move with that span. Verify its selected text after mapping.
4. **Check exact candidates.** Search within the selected file for exact selected text when mapping is unavailable or uncertain. A candidate requires matching available prefix and suffix context. If the snippet is unique but its context contradicts the baseline, do not automatically attach it. Preserve an unresolved reason instead.
5. **Resolve ambiguity conservatively.** An arbitrary diff alignment, matching line number, or nearest candidate cannot break a tie. Require one candidate supported by context or a known live edit/rename transformation. If identical duplicated blocks cannot be distinguished, return Unresolved. A zero-length anchor cannot use an empty-string search; require known edit mapping or unique two-sided context (one side at a file boundary).
6. **Handle target changes.** A known live edit or a single replacement bracketed by uniquely matched unchanged context can justify a changed location. If any accepted target text changes, return Needs review. Multiple possible replacements, full target deletion, or lost boundary context produce Unresolved. Never attach a deleted note to the next surviving line.
7. **Return evidence.** Include the current snapshot identity, range when justified, status, and reason/evidence. A timeout or unsupported case is Unresolved, not successful recovery. Do not overwrite accepted/original anchors during automatic recovery.

When exact matching follows a move, require unique supporting context. A copied passage plus deletion of the original may be indistinguishable from a move; Cote makes no semantic identity claim and leaves conflicting evidence unresolved. Branch switches are fresh snapshot comparisons; notes remain in the workspace namespace and can recover when the original branch returns.

### Live edits and undo

Normalize each document-change event into non-overlapping edits expressed against its pre-change snapshot; apply them in descending offset order. Validate document versions. If events are missed or inconsistent, resolve from snapshots instead of applying guessed offsets.

Insertions strictly before a range shift it; those strictly after do not. Insertions exactly at the start are excluded by shifting the start forward; insertions at the end are excluded by leaving the end before the insertion. Interior insertions or partial replacements mark Needs review. Full deletion marks Unresolved. For a zero-length anchor, insertion at its position moves the anchor after the inserted text; this deterministic boundary choice is not a claim of code identity.

Keep bounded session mapping history for undo/redo, and preserve the accepted snapshot on disk. Undo to accepted content restores Attached. Redo reapplies the changed/unresolved outcome. If history is unavailable, run normal recovery. Discarding a dirty buffer compares the disk content to the captured anchor; notes targeting discarded-only text remain unresolved with their original excerpt.

## Worked examples

- **Insertion above:** an anchor at displayed lines 40–45 becomes 50–55 when ten lines are inserted before it. Verified unchanged target text remains Attached.
- **Deletion above:** removing five lines before that target moves it to 35–40. Deleting the target itself produces Unresolved, not an attachment to line 40's replacement.
- **Repeated code:** two functions contain `return null;`. A note in one function may be recovered using its unique surrounding context. If both blocks and their contexts are identical after an external rewrite, return Unresolved even if one is closer to the old line.
- **Rename:** an editor rename from `src/auth.ts` to `src/session.ts` supplies a known path transformation. Verify the current passage and preserve its status. If the editor was closed, Git may propose that rename; accept only after content verification and a unique candidate. A similarity score alone is insufficient.
- **Changed condition:** `if (cachedUser)` becomes `if (cachedUser && valid)`. A known edit or uniquely bracketed replacement retains the location as Needs review; the old explanation is not automatically endorsed.

## Fixture and acceptance matrix

Each fixture specifies accepted snapshot/range, optional edit events/Git evidence, target snapshot, and expected status/range/evidence. The oracle checks the intended passage, not merely that a range was returned.

| Scenario | Required outcome |
| --- | --- |
| Insert/delete before target | Attached at correctly shifted range. |
| Insert exactly at either selection boundary | Attached to original text; inserted text excluded. |
| Interior edit or partial deletion with known mapping | Needs review at surviving/replaced target. |
| Entire target deleted | Unresolved; excerpt and body preserved. |
| Undo to accepted text; redo deletion | Attached at original target; then Unresolved again. |
| Duplicate snippet, unique context | Attached only to context-supported candidate. |
| Duplicate snippet and indistinguishable contexts | Unresolved; no nearest-line tiebreaker. |
| Same-file move with unique exact text/context | Attached at new location. |
| Rewritten/moved target without reliable boundaries | Unresolved. |
| Editor rename or unique Git rename candidate | Correct new path after verification. |
| Missing file or ambiguous rename candidates | Unresolved; no speculative thread. |
| Restart with unchanged content | Attached with identical note text and range. |
| External edits while editor closed | Same conservative outcome as snapshot recovery. |
| Switch away from branch containing target, then back | Unresolved while absent; Attached when accepted content returns. |
| Discard unsaved-only annotated content | Unresolved with dirty snapshot retained. |
| Surrogate pairs, combining characters, UTF-8 adapter conversion | Exact selected text preserved; no invalid boundaries. |
| CRLF, LF conversion, multiline/end-exclusive selections | Correct ranges; line-ending-only evidence when applicable. |
| Blank-line zero-length anchor | Known mapping or unique context required; otherwise Unresolved. |
| Git absent, untracked file, or missing historical object | Snapshot-based attachment works; unavailable rename recovery stays unresolved. |
| Diff budget exceeded | Unresolved with retry reason; UI stays responsive. |
| Storage write failure | No success acknowledgement; old durable record remains readable and pending edit is retained in session. |
| Two windows edit same note | Revision conflict is reported; no silent last-writer loss. |
| Concurrent edits to different notes | Both changes persist after serialized updates. |

All automatic mapping tests must reject silently selecting an unrelated passage. Include snapshot and event-based variants for equivalent changes, with explicit exceptions where known event history provides stronger evidence.

## References

- [Git snapshot model](https://git-scm.com/book/en/v2/Getting-Started-What-is-Git%3F)
- [Git diff and rename detection](https://git-scm.com/docs/git-diff)
- [Git patch context and application](https://git-scm.com/docs/git-apply)
- [jsdiff](https://github.com/kpdecker/jsdiff)
- [W3C TextQuoteSelector](https://www.w3.org/TR/annotation-model/#text-quote-selector)
- [VS Code positions and change events](https://code.visualstudio.com/api/references/vscode-api)
- [Neovim extmarks and API indexing](https://neovim.io/doc/user/api#api-extmarks)
