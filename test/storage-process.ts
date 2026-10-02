import { readFile } from 'node:fs/promises';
import { LocalStore, ConflictError } from '../src/storage/store';
async function main() {
  const [root, workspace, input] = process.argv.slice(2);
  const store = await LocalStore.open(root, workspace);
  await store.save(JSON.parse(await readFile(input, 'utf8')));
}
main().catch(error => { console.error(error instanceof ConflictError ? 'REVISION_CONFLICT' : error); process.exitCode = 1; });
