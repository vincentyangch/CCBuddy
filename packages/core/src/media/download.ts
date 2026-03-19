export interface FetchAttachmentOptions {
  timeoutMs?: number;
  maxBytes?: number;
}

export async function fetchAttachment(
  url: string,
  opts: FetchAttachmentOptions = {},
): Promise<Buffer> {
  const { timeoutMs = 30_000, maxBytes } = opts;

  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    throw new Error(`Failed to download attachment: HTTP ${response.status}`);
  }

  if (!response.body) {
    throw new Error('No response body');
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  for await (const chunk of response.body) {
    totalBytes += chunk.byteLength;
    if (maxBytes && totalBytes > maxBytes) {
      throw new Error(`Attachment size exceeded limit of ${maxBytes} bytes`);
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}
