import * as fs from 'fs';
import * as path from 'path';
import { gitHidden as git } from './git-hidden';

/** A one-commit repository holding `app.ts`. */
export function makeAppRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'app.ts'), 'export function appSymbol() { return 42; }\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
}
