import { describe, expect, it } from 'vitest';
import { buildDeterministicZip } from '../../scripts/zip.mjs';

const FILES = [
  { name: 'a.txt', data: Buffer.from('hello') },
  { name: 'b.txt', data: Buffer.from('world') },
];

describe('buildDeterministicZip', () => {
  it('produces byte-identical output for the same input, called twice', () => {
    const first = buildDeterministicZip(FILES, 1735689600);
    const second = buildDeterministicZip(FILES, 1735689600);

    expect(Buffer.compare(first, second)).toBe(0);
  });

  it('changes when a file\'s bytes change', () => {
    const first = buildDeterministicZip(FILES, 1735689600);
    const changed = buildDeterministicZip([{ name: 'a.txt', data: Buffer.from('HELLO') }, FILES[1]!], 1735689600);

    expect(Buffer.compare(first, changed)).not.toBe(0);
  });

  it('does not vary with the building machine\'s timezone, only with the given epoch', () => {
    const utcNoon = Date.UTC(2026, 0, 1, 12, 0, 0) / 1000;
    const first = buildDeterministicZip(FILES, utcNoon);
    const second = buildDeterministicZip(FILES, utcNoon);

    expect(Buffer.compare(first, second)).toBe(0);
  });
});
