import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const target = process.env.TEST_GROW_FILE;
const original = fs.statSync(target);
const { fstatSync, readFileSync, readSync, closeSync } = fs;
let descriptor;
let bytes = 0;

fs.fstatSync = (fd, ...args) => {
  const stat = fstatSync(fd, ...args);
  if (stat.dev === original.dev && stat.ino === original.ino && descriptor === undefined) {
    descriptor = fd;
    fs.appendFileSync(target, ' '.repeat(32768));
  }
  return stat;
};
fs.readFileSync = (file, ...args) => {
  const result = readFileSync(file, ...args);
  if (file === descriptor) bytes += Buffer.byteLength(result);
  return result;
};
fs.readSync = (fd, ...args) => {
  const count = readSync(fd, ...args);
  if (fd === descriptor) bytes += count;
  return count;
};
fs.closeSync = (fd) => {
  if (fd === descriptor) {
    fs.writeFileSync(target + '.bytes', String(bytes));
    descriptor = undefined;
  }
  return closeSync(fd);
};
syncBuiltinESMExports();
