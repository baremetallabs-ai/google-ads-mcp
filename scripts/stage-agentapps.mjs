// Stage the minimal directory that `sovereign agentapps publish` uploads.
//
// The CLI uploads every file under the directory it is given, including Git-ignored
// ones, so publishing the repository root would ship `.env` and `node_modules`. The
// owner cell also installs any root package.json and refuses dependencies with install
// hooks, which the dev toolchain has. The bundled entry needs neither: it imports only
// Node built-ins. The staged directory therefore holds exactly the manifest, the entry
// it names, and the README.
import { execFileSync } from 'node:child_process';
import { copyFile, lstat, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

const outArg = process.argv.indexOf('--out');
const out = resolve(outArg === -1 ? 'dist/agentapps-publish' : (process.argv[outArg + 1] ?? ''));
if (outArg !== -1 && !process.argv[outArg + 1]) throw new Error('--out requires a directory');

const manifest = JSON.parse(await readFile('server.json', 'utf8'));
const entry = manifest._meta?.['ai.baremetal/agentapps']?.entry?.module;
if (typeof entry !== 'string' || entry.startsWith('/') || entry.split('/').includes('..')) {
  throw new Error(
    'server.json must declare a relative _meta["ai.baremetal/agentapps"].entry.module',
  );
}

// Refuse a stale bundle: the staged entry must be what the source builds.
execFileSync(process.execPath, ['scripts/build-agentapps.mjs', '--check'], { stdio: 'inherit' });

const files = ['server.json', entry, 'README.md'];
await rm(out, { recursive: true, force: true });
for (const file of files) {
  await mkdir(dirname(join(out, file)), { recursive: true });
  await copyFile(file, join(out, file));
}

async function walk(dir) {
  const found = [];
  for (const name of await readdir(dir)) {
    const path = join(dir, name);
    const stat = await lstat(path);
    if (stat.isSymbolicLink())
      throw new Error(`Staged directory contains a symbolic link: ${path}`);
    found.push(...(stat.isDirectory() ? await walk(path) : [relative(out, path)]));
  }
  return found;
}
const staged = (await walk(out)).sort();
if (staged.join('\n') !== [...files].sort().join('\n')) {
  throw new Error(`Unexpected staged contents: ${staged.join(', ')}`);
}

console.log(`Staged ${String(staged.length)} files in ${out}:`);
for (const file of staged) console.log(`  ${file}`);
console.log(`\nPublish with: sovereign agentapps publish ${relative(process.cwd(), out) || '.'}`);
