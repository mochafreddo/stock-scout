import { readSync } from 'node:fs';

export function readBoundedUtf8(fd: number, maxBytes: number) {
  const buffer = Buffer.allocUnsafe(maxBytes + 1);
  let size = 0;
  while (size < buffer.length) {
    const count = readSync(fd, buffer, size, buffer.length - size, null);
    if (count === 0) return buffer.toString('utf8', 0, size);
    size += count;
  }
  return undefined;
}
