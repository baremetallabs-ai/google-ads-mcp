import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const artifact = resolve('agentapps/main.mjs');
// AgentApps grants only declared env names and no sys permission. These optional
// Node library probes happen during module evaluation, before our entry can run.
// gaxios also reads proxy settings on every request, including the token exchange.
const denoPermissionShims = {
  'pino/pino.js': [["const hostname = os.hostname()", "const hostname = 'agentapps'"]],
  'thread-stream/index.js': [["process.env.NODE_V8_COVERAGE", 'undefined']],
  'google-logging-utils/build/src/logging-utils.js': [["process.env[exports.env.nodeEnables]", 'undefined']],
  'gaxios/build/cjs/src/gaxios.js': [
    ["(process.env.NO_PROXY ?? process.env.no_proxy)", 'undefined'],
    [`opts.proxy ||
            process?.env?.HTTPS_PROXY ||
            process?.env?.https_proxy ||
            process?.env?.HTTP_PROXY ||
            process?.env?.http_proxy`, 'opts.proxy'],
  ],
};
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
  plugins: [{
    name: 'agentapps-deno-permissions',
    setup(build) {
      build.onLoad({ filter: /node_modules\/(pino\/pino\.js|thread-stream\/index\.js|google-logging-utils\/build\/src\/logging-utils\.js|gaxios\/build\/cjs\/src\/gaxios\.js)$/ }, async (args) => {
        const relative = args.path.slice(args.path.indexOf('node_modules/') + 'node_modules/'.length);
        let source = await readFile(args.path, 'utf8');
        for (const [needle, replacement] of denoPermissionShims[relative]) {
          if (!source.includes(needle)) throw new Error(`AgentApps permission shim no longer matches ${relative}`);
          source = source.replaceAll(needle, replacement);
        }
        return { contents: source, loader: 'js' };
      });
    },
  }],
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
