'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const files = fs.readdirSync(path.resolve(__dirname, '../tests')).filter(name => name.endsWith('.test.js')).sort().map(name => path.join('tests', name));
if (!files.length) throw new Error('No tests discovered.');
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=2', ...files], { cwd: path.resolve(__dirname, '..'), stdio: 'inherit', env: { ...process.env, OMP_NUM_THREADS: '2', OPENBLAS_NUM_THREADS: '2', DOTNET_PROCESSOR_COUNT: '2' } });
process.exit(result.status ?? 1);
