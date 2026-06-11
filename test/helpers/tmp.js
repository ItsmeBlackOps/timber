import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function mkTmpDir(prefix = 'timber-') {
  return mkdtemp(join(tmpdir(), prefix));
}

export async function rmTmpDir(dir) {
  // maxRetries: Windows can hold fds briefly after close (EBUSY/EPERM)
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
