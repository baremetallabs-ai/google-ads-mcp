/**
 * One-time helper to mint a Google Ads refresh token.
 *
 * Runs the installed-app OAuth loopback flow against a Desktop OAuth client and
 * prints the three environment values the server needs. It is not part of the
 * server: the server itself only ever reads credentials from the environment.
 *
 *   npm run get-refresh-token -- --client-secret ~/client_secret.json
 *   npm run get-refresh-token -- --client-id XXX --client-secret-value YYY
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { OAuth2Client } from 'google-auth-library';

const ADWORDS_SCOPE = 'https://www.googleapis.com/auth/adwords';

interface ClientCredentials {
  clientId: string;
  clientSecret: string;
}

function expandHome(path: string): string {
  return path.startsWith('~') ? resolve(homedir(), path.slice(1).replace(/^\/+/, '')) : resolve(path);
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg?.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        out[key] = next;
        i++;
      } else {
        out[key] = 'true';
      }
    }
  }
  return out;
}

function loadCredentials(args: Record<string, string>): ClientCredentials {
  if (args['client-id'] && args['client-secret-value']) {
    return { clientId: args['client-id'], clientSecret: args['client-secret-value'] };
  }
  const path = expandHome(args['client-secret'] ?? '~/client_secret.json');
  let parsed: { installed?: ClientSecretFile; web?: ClientSecretFile };
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as typeof parsed;
  } catch {
    throw new Error(
      `Could not read an OAuth client secret file at ${path}.\n` +
        'Pass --client-secret <path>, or --client-id and --client-secret-value directly.',
    );
  }
  const section = parsed.installed ?? parsed.web;
  if (!section?.client_id || !section.client_secret) {
    throw new Error(`${path} does not look like a Google OAuth client secret file.`);
  }
  return { clientId: section.client_id, clientSecret: section.client_secret };
}

interface ClientSecretFile {
  client_id?: string;
  client_secret?: string;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { clientId, clientSecret } = loadCredentials(args);
  const port = Number(args.port ?? '9876');
  const redirectUri = `http://localhost:${String(port)}/oauth2callback`;

  const client = new OAuth2Client({ clientId, clientSecret, redirectUri });
  const authUrl = client.generateAuthUrl({
    access_type: 'offline',
    scope: [ADWORDS_SCOPE],
    // Without this an already-consented client returns no refresh token.
    prompt: 'consent',
  });

  const code = await new Promise<string>((resolvePromise, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost:${String(port)}`);
      if (url.pathname !== '/oauth2callback') {
        res.writeHead(404).end();
        return;
      }
      const error = url.searchParams.get('error');
      const received = url.searchParams.get('code');
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      if (error ?? !received) {
        res.end(`Authorization failed: ${error ?? 'no code returned'}`);
        server.close();
        reject(new Error(`Authorization failed: ${error ?? 'no code returned'}`));
        return;
      }
      res.end('Authorization complete. You can close this tab and return to the terminal.');
      server.close();
      resolvePromise(received);
    });
    server.listen(port, () => {
      console.error('\nOpen this URL in a browser and grant access:\n');
      console.error(`  ${authUrl}\n`);
      console.error(`Waiting for the redirect on ${redirectUri} ...\n`);
    });
    server.on('error', reject);
  });

  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error(
      'Google returned no refresh token. Revoke the app at ' +
        'https://myaccount.google.com/permissions and run this again.',
    );
  }

  // Printed to stdout so it can be redirected; nothing else writes there.
  console.log('# Add these to your .env (values are secrets - do not commit):');
  console.log(`GOOGLE_ADS_CLIENT_ID=${clientId}`);
  console.log(`GOOGLE_ADS_CLIENT_SECRET=${clientSecret}`);
  console.log(`GOOGLE_ADS_REFRESH_TOKEN=${tokens.refresh_token}`);
}

main().catch((err: unknown) => {
  console.error(`\n${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
