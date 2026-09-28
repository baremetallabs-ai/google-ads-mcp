import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';

const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/agentapps-descriptors.ts'],
  { encoding: 'utf8' });
if (result.status !== 0) throw new Error(`Descriptor discovery failed: ${result.stderr}`);
const declared = JSON.parse(result.stdout);
if (declared.length !== 30) throw new Error(`Expected 30 descriptors, found ${declared.length}`);
const file = 'server.json';
const manifest = JSON.parse(await readFile(file, 'utf8'));
const profile = manifest._meta['ai.baremetal/agentapps'];
if (process.argv.includes('--check')) {
  if (JSON.stringify(profile.tools) !== JSON.stringify(declared)) {
    throw new Error('server.json tool declarations differ from controlled runtime discovery');
  }
} else {
  profile.tools = declared;
  await writeFile(file, JSON.stringify(manifest, null, 2) + '\n');
}
