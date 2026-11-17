import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CodeGraph } from '../../../src';
import * as fatalHandler from '../../../src/bin/fatal-handler';
import { EndedJobsFile } from '../../../src/extensions/host/builder/ended-jobs-file';
import { stoppedIndexNote } from '../../../src/extensions/host/builder/stopped-index-note';
import { __resetExtensionsForTests, registerExtension } from '../../../src/extensions/host/registry';
import queriesExtension from '../../../src/extensions/queries/extension';
import { getGlyphs } from '../../../src/ui/glyphs';

let repo: string;
let stateDir: string;

beforeAll(async () => {
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cli-color-')));
  stateDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cli-color-state-')));
  const git = spawnSync('git', ['init', '-q'], { cwd: repo, encoding: 'utf8' });
  if (git.status !== 0) throw new Error(`git init failed: ${git.stderr}`);
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src', 'util.ts'), 'export function helper(): number { return 1; }\n');
  const cg = await CodeGraph.init(repo);
  await cg.indexAll();
  cg.close();
}, 30_000);

afterAll(() => {
  if (repo) fs.rmSync(repo, { recursive: true, force: true });
  if (stateDir) fs.rmSync(stateDir, { recursive: true, force: true });
});

describe('CLI stopped-index warning color', () => {
  it('--color colours the warning when stdout is not a TTY', async () => {
    const mark = { root: repo, kind: 'open', limit: 'time', at: '2026-11-17T10:00:00Z' } as const;
    new EndedJobsFile(path.join(stateDir, 'builder-ended-jobs.jsonl')).append(mark);
    const previousArgv = process.argv;
    const previousExitCode = process.exitCode;
    const tty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    vi.stubEnv('CODEGRAPH_STATE_DIR', stateDir);
    vi.stubEnv('CODEGRAPH_EXTENSION_MODULES', '');
    vi.stubEnv('CODEGRAPH_WASM_RELAUNCHED', '1');
    vi.stubEnv('CODEGRAPH_NO_DAEMON', '1');
    vi.stubEnv('DO_NOT_TRACK', '1');
    vi.stubEnv('NO_COLOR', '');
    vi.stubEnv('FORCE_COLOR', '');
    vi.stubEnv('CI', '');
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false });
    __resetExtensionsForTests();
    registerExtension(queriesExtension);
    process.argv = [process.execPath, path.resolve(__dirname, '../../../src/bin/codegraph.ts'),
      'grep', 'helper', '-p', repo, '--color'];
    process.exitCode = undefined;
    vi.spyOn(fatalHandler, 'installFatalHandlers').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation((code) => { throw new Error(`unexpected process.exit(${code})`); });
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    let stderr = '';
    let signalOutput: () => void = () => {};
    const output = new Promise<void>((resolve) => { signalOutput = resolve; });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stderr += String(chunk);
      signalOutput();
      return true;
    });
    try {
      await import('../../../src/bin/codegraph');
      await output;
      expect(process.exitCode, JSON.stringify(stderr)).toBe(0);
      expect(JSON.stringify(stderr.split('\n')[0] + '\n'))
        .toBe(JSON.stringify(`\u001b[33m${getGlyphs().warn}\u001b[0m ${stoppedIndexNote(mark)}\n`));
    } finally {
      process.argv = previousArgv;
      process.exitCode = previousExitCode;
      if (tty) Object.defineProperty(process.stdout, 'isTTY', tty);
      else Reflect.deleteProperty(process.stdout, 'isTTY');
      __resetExtensionsForTests();
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    }
  });
});
