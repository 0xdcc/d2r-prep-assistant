'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { executable, runProcess } = require('../src/engine/process');
const { loadManifest } = require('../src/engine/manifest');

async function temporary(test) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'd2r-protocol-test-'));
  test.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function python() {
  const found = await executable(['python3', 'python']);
  if (!found) throw new Error('Archive integration tests require Python 3.9+ on the test host.');
  return found;
}

async function zipFixture(root, entries, filename = 'synthetic-protocol-only.zip') {
  const spec = path.join(root, `${filename}.json`);
  const archive = path.join(root, filename);
  await fs.writeFile(spec, JSON.stringify(entries));
  const script = 'import json,sys,zipfile,base64; entries=json.load(open(sys.argv[1])); z=zipfile.ZipFile(sys.argv[2],"w"); [(lambda i,e: (setattr(i,"external_attr",e.get("mode",0o100600)<<16),z.writestr(i,base64.b64decode(e["base64"]) if "base64" in e else e.get("data","synthetic protocol fixture"))))(zipfile.ZipInfo(e["name"]),e) for e in entries]; z.close()';
  await runProcess(await python(), ['-I', '-c', script, spec, archive], { cwd: root });
  return archive;
}

const manifest = () => loadManifest(path.resolve(__dirname, '../manifests/upstream.json'));
module.exports = { temporary, python, zipFixture, manifest };
