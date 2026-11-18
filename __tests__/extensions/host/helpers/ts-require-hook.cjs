const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const ts = require('typescript');

const cacheDir = path.join(os.tmpdir(), 'codegraph-test-ts-require-cache');
fs.mkdirSync(cacheDir, { recursive: true });
require.extensions['.ts'] = (module, filename) => {
  const stat = fs.statSync(filename);
  const key = crypto.createHash('sha256').update(`${filename}\0${stat.mtimeMs}\0${ts.version}`).digest('hex');
  const cached = path.join(cacheDir, `${key}.js`);
  let output;
  try {
    output = fs.readFileSync(cached, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
      fileName: filename,
    }).outputText;
    fs.writeFileSync(cached, output);
  }
  module._compile(output, filename);
};
