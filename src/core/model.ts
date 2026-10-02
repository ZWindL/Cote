export type Position = { line: number; character: number };
export type Range = { start: Position; end: Position };
export type Snapshot = { id: string; text: string };
export type Anchor = {
  workspaceId: string; relativePath: string; range: Range; exact: string;
  prefix: string; suffix: string; snapshotId: string;
  git?: { head: string; repositoryRelativePath: string };
};
export type Location = { relativePath: string; range: Range; snapshotId: string };
export type Resolution =
  | { status: 'attached' | 'needs-review'; location: Location; evidence: string[] }
  | { status: 'unresolved'; reason: string; evidence: string[] };
export type Note = {
  id: string; revision: number; body: string; createdAt: string; updatedAt: string;
  original: Anchor; accepted: Anchor; resolution?: Resolution;
  pathHint?: { relativePath: string; evidence: 'verified-rename' };
};
export type TextEdit = { range: Range; text: string };
export type Candidate = { relativePath: string; snapshot: Snapshot; pathEvidence: string[] };
export type ResolveInput = {
  accepted: Anchor; baseline: Snapshot; candidates: Candidate[];
  previous?: { location: Location; snapshot: Snapshot };
};
export type ChangeInput = {
  accepted: Anchor; baseline: Snapshot; before: Snapshot; after: Snapshot;
  previous: Resolution; edits: TextEdit[];
};
export const unresolved = (reason: string, evidence: string[] = []): Resolution =>
  ({ status: 'unresolved', reason, evidence });
