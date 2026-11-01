import { createServer } from 'node:net';

const server = createServer();
server.once('error', (error) => {
  console.error(`Environment error: loopback preflight failed (${error}); tests not run.`);
  process.exitCode = 1;
});
server.listen(0, '127.0.0.1', () => server.close());
