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
  await rename(tmp, target);
}
