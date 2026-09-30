import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? listFiles(path) : [path];
  });
}

describe('AgentApps publish staging', () => {
  it('stages only the manifest, its entry module, and the README', () => {
    const out = join(mkdtempSync(join(tmpdir(), 'gads-stage-')), 'publish');
    dirs.push(out);
    const run = spawnSync(process.execPath, ['scripts/stage-agentapps.mjs', '--out', out], {
      encoding: 'utf8',
    });
    expect(run.status, run.stderr).toBe(0);

    const staged = listFiles(out)
      .map((path) => relative(out, path))
      .sort();
    expect(staged).toEqual(['README.md', 'agentapps/main.mjs', 'server.json']);
    expect(staged).not.toContain('package.json');
    for (const file of staged) expect(readFileSync(join(out, file))).toEqual(readFileSync(file));
  });
});
