// Stage the minimal directory that `sovereign agentapps publish` uploads.
//
// The CLI uploads every file under the directory it is given, including Git-ignored
// ones, so publishing the repository root would ship `.env` and `node_modules`. The
// owner cell also installs any root package.json and refuses dependencies with install
// hooks, which the dev toolchain has. The bundled entry needs neither: it imports only
// Node built-ins. The staged directory therefore holds exactly the manifest, the entry
// it names, and the README.
//
// Usage: node scripts/stage-agentapps.mjs [--out <dir>] [--slug <slug>] [--allow-dirty]
import { execFileSync } from 'node:child_process';
import { copyFile, lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// AgentApps requires a lowercase kebab-case slug, and server.json `name` must equal it.
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// eve's AgentApps extension exposes tools as `apps__cell__<slug>__<tool>` and rejects
// names over 64 characters. `get_bidding_strategy_status` is the longest tool here.
const QUALIFIED_NAME_LIMIT = 64;
const LONGEST_TOOL = 'get_bidding_strategy_status';

function parseArgs(argv) {
  const options = { allowDirty: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--allow-dirty') {
      options.allowDirty = true;
      continue;
    }
    const match = /^--(out|slug)(?:=(.*))?$/.exec(arg);
    if (!match) throw new Error(`Unknown argument: ${arg}`);
    const value = match[2] ?? argv[++i];
    if (!value) throw new Error(`--${match[1]} requires a value`);
    options[match[1]] = value;
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));

const manifest = JSON.parse(await readFile(join(root, 'server.json'), 'utf8'));
const profile = manifest._meta?.['ai.baremetal/agentapps'];
const entry = profile?.entry?.module;
if (typeof entry !== 'string' || entry.startsWith('/') || entry.split('/').includes('..')) {
  throw new Error(
    'server.json must declare a relative _meta["ai.baremetal/agentapps"].entry.module',
  );
}
const files = ['server.json', entry, 'README.md'];

if (options.slug !== undefined) {
  if (!SLUG_PATTERN.test(options.slug)) {
    throw new Error(`--slug must be lowercase kebab-case (a-z, 0-9, -): ${options.slug}`);
  }
  const qualified = `apps__cell__${options.slug}__${LONGEST_TOOL}`;
  if (qualified.length > QUALIFIED_NAME_LIMIT) {
    throw new Error(
      `--slug is too long: ${qualified} is ${String(qualified.length)} characters, over eve's ${String(QUALIFIED_NAME_LIMIT)}`,
    );
  }
}

const out = resolve(
  options.out ??
    join(root, 'dist', options.slug ? `agentapps-publish-${options.slug}` : 'agentapps-publish'),
);

// The output directory is deleted before staging, so it must be absent or hold nothing
// but staged files. Anything else, such as the checkout, an ancestor of it, or a source
// directory, is refused rather than erased. The check descends only into directories
// that lead to a staged file, so pointing it at a large tree fails fast.
if (out === root || root.startsWith(out + sep)) {
  throw new Error(`--out must not be the repository or one of its ancestors: ${out}`);
}
async function firstUnexpected(dir) {
  for (const name of await readdir(dir)) {
    const path = join(dir, name);
    const rel = relative(out, path).split(sep).join('/');
    const stat = await lstat(path);
    if (stat.isDirectory() && files.some((file) => file.startsWith(`${rel}/`))) {
      const nested = await firstUnexpected(path);
      if (nested) return nested;
    } else if (stat.isSymbolicLink() || !stat.isFile() || !files.includes(rel)) {
      return rel;
    }
  }
  return undefined;
}
const existing = await lstat(out).catch((error) => {
  if (error.code === 'ENOENT') return undefined;
  throw error;
});
if (existing) {
  if (!existing.isDirectory()) throw new Error(`--out exists and is not a directory: ${out}`);
  const unexpected = await firstUnexpected(out);
  if (unexpected) {
    throw new Error(
      `--out is not a staging directory, refusing to replace it: ${out} (contains ${unexpected})`,
    );
  }
}

// The staged files must be what the reviewed revision holds.
if (!options.allowDirty) {
  const dirty = execFileSync('git', ['status', '--porcelain', '--', ...files], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  if (dirty) {
    throw new Error(
      `Uncommitted changes to staged files; commit them or pass --allow-dirty:\n${dirty}`,
    );
  }
}

// Refuse a stale bundle: the staged entry must be what the source builds.
execFileSync(process.execPath, [join(root, 'scripts/build-agentapps.mjs'), '--check'], {
  cwd: root,
  stdio: 'inherit',
});

await rm(out, { recursive: true, force: true });
for (const file of files) {
  await mkdir(dirname(join(out, file)), { recursive: true });
  await copyFile(join(root, file), join(out, file));
}
if (options.slug !== undefined) {
  profile.slug = options.slug;
  manifest.name = options.slug;
  await writeFile(join(out, 'server.json'), `${JSON.stringify(manifest, null, 2)}\n`);
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

console.log(
  `Staged ${String(staged.length)} files in ${out}${options.slug ? ` as ${options.slug}` : ''}:`,
);
for (const file of staged) console.log(`  ${file}`);
console.log(`\nPublish with: sovereign agentapps publish ${relative(process.cwd(), out) || '.'}`);
