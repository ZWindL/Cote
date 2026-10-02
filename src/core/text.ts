import { createHash } from 'node:crypto';
import { Position, Range, Snapshot } from './model';

export function hash(text: string): string { return createHash('sha256').update(text, 'utf8').digest('hex'); }
export function snapshot(text: string): Snapshot { return { id: hash(text), text }; }
export function validateSnapshot(value: Snapshot): void {
  if (!value || typeof value.text !== 'string' || value.id !== hash(value.text)) throw new Error('Invalid snapshot hash');
}

export class TextIndex {
  readonly starts = [0];
  readonly ends: number[] = [];
  constructor(readonly text: string) {
    const breaks = /\r\n|\r|\n/g;
    for (let match; (match = breaks.exec(text));) {
      this.ends.push(match.index);
      this.starts.push(match.index + match[0].length);
    }
    this.ends.push(text.length);
  }
  private boundary(offset: number) {
    if (offset > 0 && offset < this.text.length) {
      const before = this.text.charCodeAt(offset - 1), after = this.text.charCodeAt(offset);
      if ((before === 13 && after === 10) ||
        (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff))
        throw new Error('Position splits a line terminator or Unicode surrogate pair');
    }
  }
  offset(p: Position): number {
    if (!p || !Number.isInteger(p.line) || !Number.isInteger(p.character) || p.line < 0 ||
      p.line >= this.starts.length || p.character < 0 || p.character > this.ends[p.line] - this.starts[p.line])
      throw new Error('Position outside snapshot');
    const offset = this.starts[p.line] + p.character;
    this.boundary(offset);
    return offset;
  }
  position(offset: number): Position {
    if (!Number.isInteger(offset) || offset < 0 || offset > this.text.length) throw new Error('Offset outside snapshot');
    this.boundary(offset);
    let low = 0, high = this.starts.length - 1;
    while (low < high) { const mid = Math.ceil((low + high) / 2); if (this.starts[mid] <= offset) low = mid; else high = mid - 1; }
    if (offset > this.ends[low]) throw new Error('Offset inside line terminator');
    return { line: low, character: offset - this.starts[low] };
  }
  offsets(range: Range): [number, number] {
    const start = this.offset(range.start), end = this.offset(range.end);
    if (start > end) throw new Error('Reversed range');
    return [start, end];
  }
  range(start: number, end: number): Range {
    if (start > end) throw new Error('Reversed range');
    return { start: this.position(start), end: this.position(end) };
  }
  selected(range: Range): string { const [s, e] = this.offsets(range); return this.text.slice(s, e); }
}

export function validRelativePath(value: string): boolean {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0') && !value.includes('\\') &&
    !value.startsWith('/') && !/^[A-Za-z]:/.test(value) && !value.split('/').some(p => p === '..' || p === '.' || p === '');
}
