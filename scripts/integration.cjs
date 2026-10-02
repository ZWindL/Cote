const { runTests } = require('@vscode/test-electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const root = path.resolve(__dirname, '..');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'cote-vscode-'));
fs.mkdirSync(path.join(sandbox, 'workspace'));
const executable = process.env.COTE_VSCODE_EXECUTABLE || (process.platform === 'darwin'
  ? '/Applications/Visual Studio Code.app/Contents/MacOS/Code' : undefined);
const options = {
  vscodeExecutablePath: executable,
  extensionDevelopmentPath: root,
  extensionTestsPath: path.join(root, 'out/test/integration/index.js'),
  launchArgs: [path.join(sandbox, 'workspace'), '--user-data-dir', path.join(sandbox, 'user'),
    '--extensions-dir', path.join(sandbox, 'extensions'), '--disable-workspace-trust',
    '--skip-welcome', '--skip-release-notes', '--disable-updates', '--disable-extensions']
};
runTests({ ...options, extensionTestsEnv: { COTE_TEST_PHASE: 'initial' } })
  .then(() => runTests({ ...options, extensionTestsEnv: { COTE_TEST_PHASE: 'restart' } }))
  .then(() => fs.rmSync(sandbox, { recursive: true, force: true }))
  .catch(error => { console.error(error); process.exitCode = 1; });
