/** Count UTF-8 byte length of a string. */
function byteLength(str: string): number {
  return Buffer.byteLength(str, 'utf8');
}

/**
 * Split `str` at a boundary that is at most `maxBytes` UTF-8 bytes.
 * Never splits in the middle of a surrogate pair.
 */
function splitAtByteLimit(str: string, maxBytes: number): [string, string] {
  if (byteLength(str) <= maxBytes) return [str, ''];
  // Walk characters, accumulating byte cost
  let bytes = 0;
  let i = 0;
  while (i < str.length) {
    const code = str.codePointAt(i)!;
    const charLen = code > 0xFFFF ? 2 : 1; // surrogate pair = 2 UTF-16 code units
    const charBytes = code <= 0x7F ? 1 : code <= 0x7FF ? 2 : code <= 0xFFFF ? 3 : 4;
    if (bytes + charBytes > maxBytes) break;
    bytes += charBytes;
    i += charLen;
  }
  return [str.slice(0, i), str.slice(i)];
}

export function chunkMessage(text: string, maxLength: number): string[] {
  if (!text) return [];
  if (byteLength(text) <= maxLength) return [text];

  const chunks: string[] = [];
  let current = '';
  let isRemainder = false;

  for (const line of text.split('\n')) {
    const withLine = current ? current + '\n' + line : line;

    if (byteLength(withLine) <= maxLength) {
      current = withLine;
      isRemainder = false;
    } else if (!current) {
      let remaining = line;
      while (byteLength(remaining) > maxLength) {
        const [head, tail] = splitAtByteLimit(remaining, maxLength);
        chunks.push(head);
        remaining = tail;
      }
      current = remaining;
      isRemainder = true;
    } else if (isRemainder) {
      // Remainder from a hard split: combine with next line only if it fits
      if (byteLength(withLine) <= maxLength) {
        current = withLine;
        isRemainder = false;
      } else {
        chunks.push(current);
        current = line;
        isRemainder = false;
      }
    } else {
      chunks.push(current);
      if (byteLength(line) > maxLength) {
        let remaining = line;
        while (byteLength(remaining) > maxLength) {
          const [head, tail] = splitAtByteLimit(remaining, maxLength);
          chunks.push(head);
          remaining = tail;
        }
        current = remaining;
        isRemainder = true;
      } else {
        current = line;
        isRemainder = false;
      }
    }
  }

  if (current) chunks.push(current);
  return chunks;
}
