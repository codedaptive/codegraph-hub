/**
 * R-49(a) hook-ins outside host's scan code (host's r49-shebang-hookin-lines.md, items C and D):
 * - C: git's deleted list keeps a deleted extensionless script, which can no longer be read for its `#!` line.
 * - D: a sync's parameter-flow snapshot takes a new extensionless Ruby script's language from its content.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseConnection } from '../../../src/db';
import { QueryBuilder } from '../../../src/db/queries';
import { getGitChangedFiles } from '../../../src/extraction';
import { FlowChange } from '../../../src/resolution/parameter-flow';
import { gitInitTempRoot } from '../../helpers/git-init-temp-root';

const roots: string[] = [];
let db: DatabaseConnection | null = null;

function tempRoot(prefix: string): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  roots.push(root);
  return root;
}

function git(root: string, args: string[]): void {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
    cwd: root, stdio: 'ignore',
  });
}

afterEach(() => {
  db?.close();
  db = null;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('git deleted list (R-49 C)', () => {
  it('keeps a deleted tracked extensionless script', () => {
    const root = gitInitTempRoot(tempRoot('cg-shebang-deleted-'));
    fs.mkdirSync(path.join(root, 'bin'));
    fs.writeFileSync(path.join(root, 'bin', 'tool'), '#!/usr/bin/env python3\ndef main():\n    return 1\n');
    fs.writeFileSync(path.join(root, 'app.py'), 'def run():\n    return 2\n');
    git(root, ['add', '-A']);
    git(root, ['commit', '-q', '-m', 'init']);
    fs.unlinkSync(path.join(root, 'bin', 'tool'));
    fs.unlinkSync(path.join(root, 'app.py'));

    const changes = getGitChangedFiles(root);
    expect(changes).not.toBeNull();
    expect(changes!.deleted).toContain('bin/tool');
    expect(changes!.deleted).toContain('app.py');
  });

  it('still drops a deleted dotted file that is not source', () => {
    const root = gitInitTempRoot(tempRoot('cg-shebang-deleted-'));
    fs.writeFileSync(path.join(root, 'notes.bin'), 'x\n');
    git(root, ['add', '-A']);
    git(root, ['commit', '-q', '-m', 'init']);
    fs.unlinkSync(path.join(root, 'notes.bin'));

    expect(getGitChangedFiles(root)!.deleted).not.toContain('notes.bin');
  });
});

describe('parameter-flow snapshot before a sync (R-49 D)', () => {
  function queries(): QueryBuilder {
    db = DatabaseConnection.initialize(path.join(tempRoot('cg-shebang-flow-'), 'test.db'));
    return new QueryBuilder(db.getDb());
  }

  it('records Ruby for a new extensionless script whose #! names ruby', () => {
    const change = new FlowChange(queries());
    change.before('bin/rails', '#!/usr/bin/env ruby\nputs "hi"\n');
    expect([...change.languages.keys()]).toEqual(['ruby']);
  });

  it('records nothing for a new extensionless script of a language with no parameter flows', () => {
    const change = new FlowChange(queries());
    change.before('bin/tool', '#!/usr/bin/env python3\nprint(1)\n');
    expect(change.languages.size).toBe(0);
  });

  it('records nothing for an extensionless path with no row and no content', () => {
    const change = new FlowChange(queries());
    change.before('bin/rails');
    expect(change.languages.size).toBe(0);
  });
});
