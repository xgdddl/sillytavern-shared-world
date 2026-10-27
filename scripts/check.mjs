import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    const result = [];
    for (const entry of entries) {
        if (['.git', 'node_modules', 'artifacts'].includes(entry.name)) continue;
        const full = path.join(directory, entry.name);
        result.push(...(entry.isDirectory() ? await walk(full) : [full]));
    }
    return result;
}
const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
for (const file of [manifest.js, manifest.css]) await readFile(path.join(root, file));
assert.equal(manifest.generate_interceptor, 'sharedWorldBeforeGenerate');
const files = (await walk(root)).filter((file) => /\.(m?js)$/.test(file));
for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (result.status !== 0) { process.stderr.write(result.stderr); process.exit(1); }
}
console.log('manifest 与 ' + files.length + ' 个 JavaScript 文件语法检查通过');
