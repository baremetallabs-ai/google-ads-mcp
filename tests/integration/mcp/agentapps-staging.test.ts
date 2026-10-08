import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';

// Each staging run executes a full esbuild bundle through `build-agentapps.mjs --check`,
// which can approach vitest's 5 s default on slower runners.
const TIMEOUT = 30_000;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gads-stage-'));
  dirs.push(dir);
  return dir;
}

// Tests pass --allow-dirty so they also run while the staged files are being edited.
function stage(...args: string[]) {
  return spawnSync(process.execPath, ['scripts/stage-agentapps.mjs', '--allow-dirty', ...args], {
    encoding: 'utf8',
  });
}

// Safety/error probes use a disposable tree, never the developer's checkout.
// Even the ancestor outputs below remain inside the mkdtemp directory.
function fixture() {
  const root = join(tempDir(), 'parent', 'repo');
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'agentapps'));
  for (const file of [
    'server.json',
    'README.md',
    'agentapps/main.mjs',
    'scripts/stage-agentapps.mjs',
  ]) {
    copyFileSync(file, join(root, file));
  }
  // Guard probes must reach the deletion if a guard regresses, without bundling.
  writeFileSync(join(root, 'scripts/build-agentapps.mjs'), '');
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ['scripts/stage-agentapps.mjs', '--allow-dirty', ...args], {
      cwd: root,
      encoding: 'utf8',
    });
  return { root, run };
}

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? listFiles(path) : [path];
  });
}

function stagedFiles(out: string): string[] {
  return listFiles(out)
    .map((path) => relative(out, path).split(sep).join('/'))
    .sort();
}

describe('AgentApps publish staging', () => {
  it(
    'stages only the manifest, its entry module, and the README',
    () => {
      const out = join(tempDir(), 'publish');
      const run = stage('--out', out);
      expect(run.status, run.stderr).toBe(0);

      const staged = stagedFiles(out);
      expect(staged).toEqual(['README.md', 'agentapps/main.mjs', 'server.json']);
      for (const file of staged) expect(readFileSync(join(out, file))).toEqual(readFileSync(file));
    },
    TIMEOUT,
  );

  it(
    'accepts --out=<dir> and replaces a previous staging directory',
    () => {
      const out = join(tempDir(), 'publish');
      expect(stage(`--out=${out}`).status).toBe(0);
      const rerun = stage(`--out=${out}`);
      expect(rerun.status, rerun.stderr).toBe(0);
      expect(stagedFiles(out)).toEqual(['README.md', 'agentapps/main.mjs', 'server.json']);
    },
    TIMEOUT * 2,
  );

  it(
    'rewrites the slug and name for a per-client entry without touching the source',
    () => {
      const out = join(tempDir(), 'publish');
      const run = stage('--out', out, '--slug', 'google-ads-formagents');
      expect(run.status, run.stderr).toBe(0);

      const source = JSON.parse(readFileSync('server.json', 'utf8'));
      const staged = JSON.parse(readFileSync(join(out, 'server.json'), 'utf8'));
      expect(staged).toEqual({
        ...source,
        name: 'google-ads-formagents',
        _meta: {
          ...source._meta,
          'ai.baremetal/agentapps': {
            ...source._meta['ai.baremetal/agentapps'],
            slug: 'google-ads-formagents',
          },
        },
      });
      expect(readFileSync(join(out, 'agentapps/main.mjs'))).toEqual(
        readFileSync('agentapps/main.mjs'),
      );
    },
    TIMEOUT,
  );

  it('rejects malformed and overlong slugs', () => {
    expect(stage('--out', join(tempDir(), 'p'), '--slug', 'Google_Ads').status).not.toBe(0);
    const long = stage('--out', join(tempDir(), 'p'), '--slug', 'google-ads-a-very-long-client');
    expect(long.status).not.toBe(0);
    expect(long.stderr).toContain('too long');
  });

  it('refuses the repository root and its ancestors as --out', () => {
    const sandbox = fixture();
    for (const out of ['.', '..', '../..']) {
      const run = sandbox.run('--out', out);
      expect(run.status).not.toBe(0);
      expect(run.stderr).toContain('must not be the repository');
    }
    expect(existsSync(join(sandbox.root, 'package.json'))).toBe(true);
  });

  it('refuses to replace a directory that holds anything but staged files', () => {
    const out = tempDir();
    writeFileSync(join(out, 'keep.txt'), 'precious');
    mkdirSync(join(out, 'agentapps'));
    writeFileSync(join(out, 'agentapps', 'other.mjs'), '');

    const run = stage('--out', out);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('not a staging directory');
    expect(readFileSync(join(out, 'keep.txt'), 'utf8')).toBe('precious');

    // A source directory inside the checkout is refused the same way.
    const sandbox = fixture();
    const src = sandbox.run('--out', 'agentapps');
    expect(src.status).not.toBe(0);
    expect(src.stderr).toContain('not a staging directory');
    expect(existsSync(join(sandbox.root, 'agentapps/main.mjs'))).toBe(true);
  });

  it('refuses partial or modified staging contents without changing them', () => {
    const sandbox = fixture();
    const out = join(tempDir(), 'publish');
    mkdirSync(out);
    writeFileSync(join(out, 'README.md'), 'precious');
    expect(sandbox.run('--out', out).stderr).toContain('not a staging directory');
    expect(readFileSync(join(out, 'README.md'), 'utf8')).toBe('precious');
    copyFileSync('server.json', join(out, 'server.json'));
    mkdirSync(join(out, 'agentapps'));
    copyFileSync('agentapps/main.mjs', join(out, 'agentapps/main.mjs'));
    expect(sandbox.run('--out', out).stderr).toContain('not a staging directory');
    expect(readFileSync(join(out, 'README.md'), 'utf8')).toBe('precious');
  });

  it('allows a prior slug rewrite but refuses changed manifest or entry bytes', () => {
    const sandbox = fixture();
    const out = join(tempDir(), 'publish');
    expect(sandbox.run('--out', out, '--slug', 'client-one').status).toBe(0);
    expect(sandbox.run('--out', out, '--slug', 'client-two').status).toBe(0);
    const manifestPath = join(out, 'server.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.description = 'unrelated data';
    writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(sandbox.run('--out', out).stderr).toContain('not a staging directory');
    expect(JSON.parse(readFileSync(manifestPath, 'utf8')).description).toBe('unrelated data');
    copyFileSync('server.json', manifestPath);
    writeFileSync(join(out, 'agentapps/main.mjs'), 'precious');
    expect(sandbox.run('--out', out).stderr).toContain('not a staging directory');
    expect(readFileSync(join(out, 'agentapps/main.mjs'), 'utf8')).toBe('precious');
  });

  it('rejects flags consumed as option values', () => {
    for (const option of ['--out', '--slug']) {
      const run = stage(option, '--allow-dirty');
      expect(run.status).not.toBe(0);
      expect(run.stderr).toContain(`${option} requires a value`);
    }
  });

  it('rejects Windows traversal and drive paths before writing', () => {
    const sandbox = fixture();
    for (const entry of ['..\\secret', 'C:/secret', 'C:secret', '/secret', '../secret']) {
      const manifest = JSON.parse(readFileSync('server.json', 'utf8'));
      manifest._meta['ai.baremetal/agentapps'].entry.module = entry;
      writeFileSync(join(sandbox.root, 'server.json'), JSON.stringify(manifest));
      const out = join(tempDir(), 'publish');
      const run = sandbox.run('--out', out);
      expect(run.status).not.toBe(0);
      expect(run.stderr).toContain('must declare a relative');
      expect(existsSync(out)).toBe(false);
    }
  });

  it('refuses symlink sources and parent directories before deleting output', () => {
    for (const file of ['server.json', 'README.md', 'agentapps/main.mjs', 'agentapps']) {
      const sandbox = fixture();
      const out = tempDir();
      writeFileSync(join(out, 'keep.txt'), 'precious');
      const target = join(sandbox.root, file);
      rmSync(target, { recursive: true });
      symlinkSync(join(sandbox.root, 'package.json'), target);
      const run = sandbox.run('--out', out);
      expect(run.status).not.toBe(0);
      expect(run.stderr).toContain('without symbolic links');
      expect(readFileSync(join(out, 'keep.txt'), 'utf8')).toBe('precious');
    }
  });

  it('rejects unknown arguments', () => {
    const run = stage('--outt', 'x');
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('Unknown argument');
  });
});
