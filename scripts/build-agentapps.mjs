import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const artifact = resolve('agentapps/main.mjs');
const result = await build({
  entryPoints: ['src/agentapps.ts'],
  outfile: artifact,
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  target: 'es2023',
  legalComments: 'none',
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});
const bytes = result.outputFiles[0]?.contents;
if (!bytes) throw new Error('AgentApps bundle produced no output');
if (process.argv.includes('--check')) {
  const committed = await readFile(artifact);
  if (!committed.equals(bytes)) throw new Error('agentapps/main.mjs differs from source; run npm run build:agentapps');
} else {
  await mkdir(resolve('agentapps'), { recursive: true });
  await writeFile(artifact, bytes);
}
