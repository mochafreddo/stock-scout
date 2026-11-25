import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { serialize } from 'node:v8';
import { snapshot } from './toss-cli-helper.mjs';

const { TOSS_STATE_DIR: directory, TEST_MERGE_PHASE: phase } = process.env;
const list = fs.readdirSync;
fs.readdirSync = (path, ...args) => {
  if (path !== directory) return list(path, ...args);
  fs.readdirSync = list;
  syncBuiltinESMExports();
  const names = list(path, ...args);
  const recordPath = join(
    path,
    names.find((name) => name.startsWith('cooldown-')),
  );
  if (phase !== 'missing-state') {
    const statePath = join(path, 'state.json');
    const state = JSON.parse(fs.readFileSync(statePath));
    state.clock = JSON.parse(fs.readFileSync(recordPath)).clock;
    fs.writeFileSync(statePath, JSON.stringify(state));
  }
  fs.unlinkSync(recordPath);
  fs.writeFileSync(process.env.TEST_MERGE_SNAPSHOT, serialize(snapshot(path)));
  return phase === 'before-list' ? list(path, ...args) : names;
};
syncBuiltinESMExports();
