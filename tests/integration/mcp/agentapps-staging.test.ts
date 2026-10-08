import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

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

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? listFiles(path) : [path];
  });
}

function stagedFiles(out: string): string[] {
  return listFiles(out)
    .map((path) => relative(out, path))
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
    for (const out of ['.', '..', resolve('..', '..')]) {
      const run = stage('--out', out);
      expect(run.status).not.toBe(0);
      expect(run.stderr).toContain('must not be the repository');
    }
    expect(existsSync('package.json')).toBe(true);
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
    const src = stage('--out', 'agentapps');
    expect(src.status).not.toBe(0);
    expect(src.stderr).toContain('not a staging directory');
    expect(existsSync('agentapps/main.mjs')).toBe(true);
  });

  it('rejects unknown arguments', () => {
    const run = stage('--outt', 'x');
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('Unknown argument');
  });
});
