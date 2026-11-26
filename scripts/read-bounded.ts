import { isUtf8 } from 'node:buffer';
import { readSync } from 'node:fs';

export function readBoundedUtf8(fd: number, maxBytes: number) {
  const buffer = Buffer.allocUnsafe(maxBytes + 1);
  let size = 0;
  while (size < buffer.length) {
    const count = readSync(fd, buffer, size, buffer.length - size, null);
    if (count === 0) {
      const bytes = buffer.subarray(0, size);
      return isUtf8(bytes) ? bytes.toString('utf8') : undefined;
    }
    size += count;
  }
  return undefined;
}
