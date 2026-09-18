import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// tsc does not copy non-TS assets, and the config loader resolves the YAML relative
// to its own compiled location.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const from = join(root, 'src', 'capabilities', 'default-config.yaml');
const to = join(root, 'dist', 'capabilities', 'default-config.yaml');

mkdirSync(dirname(to), { recursive: true });
copyFileSync(from, to);
process.stderr.write(`copied ${from} -> ${to}\n`);
