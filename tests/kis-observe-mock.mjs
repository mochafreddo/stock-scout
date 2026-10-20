import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { basename, dirname, join } from 'node:path';
import './kis-http-mock.mjs';

const scenario = process.env.TEST_OBSERVE_CASE;
const child = basename(process.argv[1]) === 'kis-probe.ts';
if (child && scenario === 'timeout') {
  fs.mkdirSync(join(process.env.HOME, 'Library/Caches/stock-scout/issuance.lock'), { mode: 0o700 });
  fs.writeFileSync(process.env.TEST_CHILD_PID, String(process.pid), { mode: 0o600 });
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}
if (child && scenario === 'signal') process.kill(process.pid, 'SIGTERM');
if (child && scenario === 'raw-error') {
  console.error('test-key test-secret test-token account-secret');
  process.exit(2);
}
if (child && scenario === 'malformed-output') {
  console.log('test-key test-secret test-token account-secret');
  process.exit(0);
}
if (!child) {
  const spawnSync = childProcess.spawnSync;
  childProcess.spawnSync = (command, args, options) => {
    if (command !== process.execPath || basename(args[0]) !== 'kis-probe.ts')
      return spawnSync(command, args, options);
    const snapshot = dirname(args[0]);
    fs.appendFileSync(
      process.env.TEST_LAUNCH_TRACE,
      `${JSON.stringify({
        args,
        timeout: options.timeout,
        killSignal: options.killSignal,
        snapshotMode: fs.statSync(snapshot).mode & 0o777,
        snapshotFiles: Object.fromEntries(
          ['kis-probe.ts', 'kis-query.ts', 'kis-auth.ts'].map((name) => [
            name,
            {
              sha256: createHash('sha256')
                .update(fs.readFileSync(join(snapshot, name)))
                .digest('hex'),
              mode: fs.statSync(join(snapshot, name)).mode & 0o777,
            },
          ]),
        ),
      })}\n`,
      { mode: 0o600 },
    );
    const result = spawnSync(command, args, {
      ...options,
      ...(scenario === 'timeout' ? { timeout: 250 } : {}),
    });
    if (scenario === 'source-drift')
      fs.appendFileSync(join(process.env.TEST_SOURCE_ROOT, 'scripts/kis-probe.ts'), '\n');
    return result;
  };
  const openSync = fs.openSync;
  fs.openSync = (path, ...args) => {
    if (
      (scenario === 'receipt-storage' &&
        typeof path === 'string' &&
        path.endsWith('/receipt.json')) ||
      (scenario === 'response-storage' &&
        typeof path === 'string' &&
        path.endsWith('/response.json')) ||
      (scenario === 'receipt-directory-storage' &&
        typeof path === 'string' &&
        (args[0] & fs.constants.O_DIRECTORY) !== 0 &&
        fs.existsSync(join(path, 'receipt.json')))
    )
      throw new Error('test-key test-secret test-token account-secret');
    return openSync(path, ...args);
  };
  syncBuiltinESMExports();
}
