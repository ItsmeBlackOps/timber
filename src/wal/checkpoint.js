import { open, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

const CHECKPOINT_FILE = 'checkpoint.json';

const isNonNegInt = (v) => Number.isInteger(v) && v >= 0;

export async function loadCheckpoint(dir) {
  try {
    const raw = await readFile(join(dir, CHECKPOINT_FILE), 'utf8');
    const parsed = JSON.parse(raw);
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      isNonNegInt(parsed.segmentSeq) &&
      isNonNegInt(parsed.offset)
    ) {
      return { segmentSeq: parsed.segmentSeq, offset: parsed.offset };
    }
  } catch {
    // missing or unreadable file: fall through to the zero checkpoint
  }
  return { segmentSeq: 0, offset: 0 };
}

// Windows: renaming over a file that another handle briefly holds open (a
// concurrent loadCheckpoint from the healthz route, an AV scanner) fails with
// a transient EPERM/EACCES/EBUSY that clears within milliseconds. Retrying
// keeps the C5 atomic-rename contract; POSIX never takes the retry path.
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_ATTEMPTS = 10;

async function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      if (attempt >= RENAME_ATTEMPTS - 1 || !TRANSIENT_RENAME_CODES.has(err?.code)) throw err;
      await new Promise((r) => setTimeout(r, 5 + 10 * attempt));
    }
  }
}

export async function saveCheckpoint(dir, { segmentSeq, offset }) {
  const target = join(dir, CHECKPOINT_FILE);
  const tmp = `${target}.tmp`;
  const body = JSON.stringify({ segmentSeq, offset, updatedAt: new Date().toISOString() });
  const fh = await open(tmp, 'w');
  try {
    await fh.writeFile(body, 'utf8');
    // fsync before rename so the rename can never publish a partially written file
    await fh.sync();
  } finally {
    await fh.close();
  }
  await renameWithRetry(tmp, target);
}
