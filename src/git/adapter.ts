import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { watch } from 'node:fs';
import { Anchor } from '../core/model';
import { validRelativePath } from '../core/text';
const execute = promisify(execFile);
async function git(directory: string, args: string[]): Promise<string> {
  const { stdout } = await execute('git', ['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'diff.external=', ...args],
    { cwd: directory, encoding: 'utf8', timeout: 1500, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1' } });
  return stdout;
}
export async function captureGit(folder: string, file: string): Promise<Anchor['git'] | undefined> {
  try {
    const root = (await git(folder, ['rev-parse', '--show-toplevel'])).trim();
    const head = (await git(root, ['rev-parse', '--verify', 'HEAD'])).trim();
    const repositoryRelativePath = path.relative(await realpath(root), await realpath(file)).split(path.sep).join('/');
    if (!validRelativePath(repositoryRelativePath) || !/^[a-f0-9]{40,64}$/.test(head)) return;
    return { head, repositoryRelativePath };
  } catch { return undefined; }
}
export function parseRenames(output: string): Array<{ from: string; to: string }> {
  const fields = output.split('\0'), results: Array<{ from: string; to: string }> = [];
  for (let i = 0; i < fields.length && fields[i];) {
    const status = fields[i++];
    if (/^[RC]\d+$/.test(status)) {
      const from = fields[i++], to = fields[i++];
      if (status.startsWith('R') && validRelativePath(from) && validRelativePath(to)) results.push({ from, to });
    } else i++;
  }
  return results;
}
export async function renameCandidates(folder: string, metadata: Anchor['git']): Promise<string[]> {
  if (!metadata) return [];
  try {
    const root = (await git(folder, ['rev-parse', '--show-toplevel'])).trim();
    const canonicalFolder = await realpath(folder);
    const output = await git(root, ['diff', '--name-status', '-z', '--find-renames', '--no-ext-diff', '--no-textconv', metadata.head, '--']);
    return parseRenames(output).filter(r => r.from === metadata.repositoryRelativePath).map(r =>
      path.relative(canonicalFolder, path.join(root, r.to)).split(path.sep).join('/')).filter(validRelativePath);
  } catch { return []; }
}

export async function observeGit(folder: string, changed: () => void): Promise<{ dispose(): void }> {
  try {
    const directory = (await git(folder, ['rev-parse', '--absolute-git-dir'])).trim();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const watcher = watch(directory, { persistent: false }, (_event, file) => {
      if (!file || ['HEAD', 'index', 'packed-refs'].includes(file.toString())) {
        clearTimeout(timer); timer = setTimeout(changed, 150);
      }
    });
    watcher.on('error', () => { watcher.close(); });
    return { dispose() { clearTimeout(timer); watcher.close(); } };
  } catch { return { dispose() {} }; }
}
