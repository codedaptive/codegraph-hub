import { afterAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../../../src';
import { DatabaseConnection, getDatabasePath } from '../../../src/db';

const roots: string[] = [];
afterAll(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const extension = `extension P {
    static let handler: () -> Void = {}
}
`;

type Fixture = 'other-copy' | 'reached-copy' | 'single-copy';

async function checkFixture(fixture: Fixture, expectReference: boolean): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-swift-member-copy-'));
  roots.push(root);
  const files: Record<string, string> = {
    'Package.swift': `// swift-tools-version:5.9
import PackageDescription
let package = Package(name: "Fixture")
`,
    'Sources/A/Types.swift': `protocol P {}
struct Tool: P {}
${fixture !== 'other-copy' ? extension : ''}`,
    'Sources/A/Caller.swift': `enum Caller {
    static func go() { Tool.handler() }
}
`,
  };
  if (fixture !== 'single-copy') {
    files['Sources/B/Types.swift'] = `protocol P {}
${fixture === 'other-copy' ? extension : ''}`;
  }
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }

  const cg = await CodeGraph.init(root, { index: true });
  try {
    const protocols = cg.getNodesByName('P').filter((n) => n.kind === 'interface' && n.language === 'swift');
    expect(protocols.map((n) => n.filePath).sort(), 'protocol declaration copies').toEqual(
      fixture === 'single-copy' ? ['Sources/A/Types.swift'] : ['Sources/A/Types.swift', 'Sources/B/Types.swift'],
    );
    const reached = protocols.find((n) => n.filePath === 'Sources/A/Types.swift')!;
    const tool = cg.getNodesByName('Tool').find((n) => n.kind === 'struct' && n.filePath === 'Sources/A/Types.swift');
    const caller = cg.getNodesByName('go').find((n) => n.kind === 'method' && n.qualifiedName === 'Caller::go');
    expect(tool, 'A Tool exists').toBeDefined();
    expect(caller, 'A caller exists').toBeDefined();
    expect(cg.getOutgoingEdgesFrom([tool!.id], ['implements']).map((e) => e.target), 'Tool implements A P').toEqual([reached.id]);
    expect(cg.getNodesByName('handler').map((n) => ({ kind: n.kind, qualifiedName: n.qualifiedName, filePath: n.filePath })), 'indexed closure member').toEqual([
      { kind: 'constant', qualifiedName: 'P::handler', filePath: fixture === 'other-copy' ? 'Sources/B/Types.swift' : 'Sources/A/Types.swift' },
    ]);

    const outgoing = cg.getOutgoingEdgesFrom([caller!.id], ['calls', 'references']);
    expect(outgoing.filter((e) => e.kind === 'calls'), 'no call resolved').toEqual([]);
    const db = DatabaseConnection.open(getDatabasePath(root));
    try {
      const rows = db.getDb().prepare('SELECT reference_kind, status FROM unresolved_refs WHERE from_node_id = ? AND reference_name = ?')
        .all(caller!.id, 'Tool.handler') as Array<Record<string, unknown>>;
      expect(rows.map((row) => `${row.reference_kind} ${row.status}`), 'call remains unresolved').toEqual(['calls failed']);
    } finally {
      db.close();
    }
    const references = outgoing.filter((e) => e.kind === 'references' && e.target === tool!.id);
    expect(references.map((e) => ({ target: e.target, resolvedBy: e.metadata?.resolvedBy })), 'external member reference to A Tool').toEqual(
      expectReference ? [{ target: tool!.id, resolvedBy: 'swift-external-member' }] : [],
    );
  } finally {
    cg.close();
  }
}

describe('Swift inherited member declaration copies', () => {
  it('references Tool when only an unimported protocol copy declares the closure member', async () => {
    await checkFixture('other-copy', true);
  });

  it('does not reference Tool when the reached protocol copy declares the closure member', async () => {
    await checkFixture('reached-copy', false);
  });

  it('does not reference Tool when the sole protocol copy declares the closure member', async () => {
    await checkFixture('single-copy', false);
  });
});
