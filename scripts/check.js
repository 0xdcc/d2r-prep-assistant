'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { loadManifest } = require('../src/engine/manifest');

const root = path.resolve(__dirname, '..');
function walk(folder) {
  return fs.readdirSync(folder, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(path.join(folder, entry.name)) : [path.join(folder, entry.name)]);
}
const tests = walk(path.join(root, 'tests')).filter(filename => filename.endsWith('.test.js'));
if (!tests.length) throw new Error('No test files discovered; zero tests is not a pass.');
const files = ['src', 'scripts', 'tests'].flatMap(folder => walk(path.join(root, folder)));
for (const filename of files.filter(filename => filename.endsWith('.js'))) {
  const result = spawnSync(process.execPath, ['--check', filename], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
for (const filename of walk(path.join(root, 'manifests')).filter(filename => filename.endsWith('.json'))) JSON.parse(fs.readFileSync(filename, 'utf8'));
loadManifest(path.join(root, 'manifests', 'upstream.json'));
const python = spawnSync('python3', ['-I', '-c', 'import ast,pathlib; ast.parse(pathlib.Path("src/engine/archive.py").read_text())'], { cwd: root, stdio: 'inherit' });
if (python.error) console.log('Python syntax check skipped: python3 unavailable; Node checks completed.');
else if (python.status !== 0) process.exit(python.status || 1);
const html = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
if (new Set(ids).size !== ids.length) throw new Error('Duplicate renderer IDs.');
if (/\son[a-z]+\s*=|<script(?![^>]*\bsrc=)/i.test(html)) throw new Error('Inline renderer script/event handler violates CSP.');
console.log(`Checked ${files.length} source/test files; ${tests.length} test suites discovered; all manifests valid.`);
