// Loads .ts files through ts.transpileModule and caches the output in the OS temp dir, shared by every process.
// The key is the source content, so an edit that keeps the timestamp still misses. Parallel processes fill the
// cache at once, so an entry is written to a unique temp name and renamed into place: a reader sees it whole or
// not at all. A failed cache write only costs the cache; the module still loads.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const ts = require('typescript');

const cacheDir = path.join(os.tmpdir(), 'codegraph-test-ts-require-cache');
fs.mkdirSync(cacheDir, { recursive: true });

function store(cached, output) {
  const temp = `${cached}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temp, output);
    fs.renameSync(temp, cached);
  } catch {
    try {
      fs.unlinkSync(temp);
    } catch {}
  }
}

require.extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8');
  const key = crypto.createHash('sha256').update(`${filename}\0${source}\0${ts.version}`).digest('hex');
  const cached = path.join(cacheDir, `${key}.js`);
  let output;
  try {
    output = fs.readFileSync(cached, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    output = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
      fileName: filename,
    }).outputText;
    store(cached, output);
  }
  module._compile(output, filename);
};
