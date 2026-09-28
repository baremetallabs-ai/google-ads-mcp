import { buildTestServer } from '../tests/helpers/build-test-server.js';

const harness = await buildTestServer();
try {
  const { tools } = await harness.client.listTools();
  process.stdout.write(JSON.stringify(tools.map(({ name, description, inputSchema, outputSchema }) =>
    ({ name, description, inputSchema, outputSchema }))));
} finally {
  await harness.close();
}
