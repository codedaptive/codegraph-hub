// The TypeScript require hook keeps cache failures isolated and reloads changed source content.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const hook = path.resolve(__dirname, 'helpers/ts-require-hook.cjs');
let dir: string;
let fixture: string;
let writer: ChildProcess | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ts-hook-'));
  fixture = path.join(dir, 'fixture.ts');
});

afterEach(() => {
  if (writer && writer.exitCode === null && writer.signalCode === null) writer.kill();
  writer = undefined;
  fs.rmSync(dir, { recursive: true, force: true });
});

function load(failCacheWrite = false): { status: number | null; output: string } {
  const child = spawnSync(process.execPath, ['-e', `
    const fs = require('node:fs');
    const path = require('node:path');
    const cacheDir = path.join(require('node:os').tmpdir(), 'codegraph-test-ts-require-cache');
    if (${failCacheWrite}) {
      const write = fs.writeFileSync;
      fs.writeFileSync = function (file, ...args) {
        if (typeof file === 'string' && path.resolve(file).startsWith(cacheDir + path.sep)) {
          fs.closeSync(fs.openSync(file, 'w'));
          throw new Error('injected cache write failure');
        }
        return write.call(this, file, ...args);
      };
    }
    try {
      require(${JSON.stringify(hook)});
      const loaded = require(${JSON.stringify(fixture)});
      console.log(JSON.stringify(typeof loaded.value === 'function' ? loaded.value() : 'missing export'));
    } catch (error) {
      console.log(JSON.stringify('load failed: ' + error.message));
    }
  `], { encoding: 'utf8', env: { ...process.env, TMPDIR: dir } });
  return { status: child.status, output: child.stdout.trim() };
}

describe('TypeScript require hook cache', { timeout: 30_000 }, () => {
  it('loads the real export while another process is writing the cache entry', async () => {
    fs.writeFileSync(fixture, 'export function value(): string { return "whole"; }\n');
    const parked = path.join(dir, 'parked');
    const release = path.join(dir, 'release');
    writer = spawn(process.execPath, ['-e', `
      const fs = require('node:fs');
      const path = require('node:path');
      const cacheDir = path.join(require('node:os').tmpdir(), 'codegraph-test-ts-require-cache');
      const write = fs.writeFileSync;
      fs.writeFileSync = function (file, ...args) {
        if (typeof file !== 'string' || !path.resolve(file).startsWith(cacheDir + path.sep)) {
          return write.call(this, file, ...args);
        }
        const fd = fs.openSync(file, 'w');
        try {
          write(${JSON.stringify(parked)}, '');
          const deadline = Date.now() + 20_000;
          const signal = new Int32Array(new SharedArrayBuffer(4));
          while (!fs.existsSync(${JSON.stringify(release)})) {
            if (Date.now() >= deadline) throw new Error('timed out waiting for release');
            Atomics.wait(signal, 0, 0, 10);
          }
          return write.call(this, fd, ...args);
        } finally {
          fs.closeSync(fd);
        }
      };
      require(${JSON.stringify(hook)});
      const loaded = require(${JSON.stringify(fixture)});
      console.log(JSON.stringify(typeof loaded.value === 'function' ? loaded.value() : 'missing export'));
    `], { env: { ...process.env, TMPDIR: dir }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let errors = '';
    writer.stdout?.on('data', (data: Buffer) => { output += data.toString(); });
    writer.stderr?.on('data', (data: Buffer) => { errors += data.toString(); });
    const finished = new Promise<number | null>((resolve, reject) => {
      writer?.once('error', reject);
      writer?.once('close', resolve);
    });

    let reader: { status: number | null; output: string };
    let status: number | null;
    try {
      const deadline = Date.now() + 20_000;
      while (!fs.existsSync(parked)) {
        if (writer.exitCode !== null || writer.signalCode !== null) throw new Error(`writer exited: ${errors}`);
        if (Date.now() >= deadline) throw new Error(`timed out waiting for writer: ${errors}`);
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      reader = load();
    } finally {
      fs.writeFileSync(release, '');
      status = await finished;
    }

    expect(reader).toEqual({ status: 0, output: '"whole"' });
    expect({ status, output: output.trim() }).toEqual({ status: 0, output: '"whole"' });
  });

  it('loads the module after a cache write fails and in a later process', () => {
    fs.writeFileSync(fixture, 'export function value(): string { return "whole"; }\n');

    const first = load(true);
    const later = load();

    expect({ first, later }).toEqual({
      first: { status: 0, output: '"whole"' },
      later: { status: 0, output: '"whole"' },
    });
  });

  it('loads changed content even when the file timestamp is restored', () => {
    fs.writeFileSync(fixture, 'export function value(): string { return "before"; }\n');
    const originalTime = new Date('2020-01-02T03:04:05.000Z');
    fs.utimesSync(fixture, originalTime, originalTime);
    const stat = fs.statSync(fixture);
    const first = load();

    fs.writeFileSync(fixture, 'export function value(): string { return "after"; }\n');
    fs.utimesSync(fixture, stat.atime, stat.mtime);
    const later = load();

    expect({ first, later }).toEqual({
      first: { status: 0, output: '"before"' },
      later: { status: 0, output: '"after"' },
    });
  });
});
