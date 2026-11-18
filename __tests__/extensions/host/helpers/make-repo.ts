import * as fs from 'fs';
import * as path from 'path';
import { git } from './git';

/** A one-commit repository holding `file` with `body`. */
export function makeRepo(dir: string, file = 'app.ts', body = 'export function appSymbol() { return 42; }\n'): void {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, file), body);
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
}
