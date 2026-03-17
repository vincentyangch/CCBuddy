import { describe, it, expect } from 'vitest';
import { chunkMessage } from '../chunker.js';

describe('chunkMessage', () => {
  it('returns empty array for empty string', () => {
    expect(chunkMessage('', 100)).toEqual([]);
  });

  it('returns single chunk when text fits', () => {
    expect(chunkMessage('hello', 100)).toEqual(['hello']);
  });

  it('splits on newline boundaries', () => {
    const text = 'line one\nline two\nline three';
    const chunks = chunkMessage(text, 18);
    expect(chunks).toEqual(['line one\nline two', 'line three']);
  });

  it('hard-splits lines exceeding max length', () => {
    const text = 'a'.repeat(15);
    const chunks = chunkMessage(text, 10);
    expect(chunks).toEqual(['a'.repeat(10), 'a'.repeat(5)]);
  });

  it('combines short lines after hard split remainder', () => {
    const text = 'a'.repeat(15) + '\nshort';
    const chunks = chunkMessage(text, 10);
    expect(chunks).toEqual(['a'.repeat(10), 'a'.repeat(5) + '\nshort']);
  });

  it('handles multiple newlines correctly', () => {
    const lines = Array.from({ length: 5 }, (_, i) => `line${i}`);
    const text = lines.join('\n');
    const chunks = chunkMessage(text, 11);
    expect(chunks).toEqual(['line0\nline1', 'line2\nline3', 'line4']);
  });

  it('handles exact boundary fit', () => {
    const text = 'ab\ncd';
    expect(chunkMessage(text, 5)).toEqual(['ab\ncd']);
  });

  it('handles discord 2000 char limit', () => {
    const text = 'a'.repeat(2500);
    const chunks = chunkMessage(text, 2000);
    expect(chunks.length).toBe(2);
    expect(chunks[0].length).toBe(2000);
    expect(chunks[1].length).toBe(500);
  });
});
