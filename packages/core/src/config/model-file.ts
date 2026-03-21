import { readFileSync, writeFileSync, renameSync } from 'node:fs';

export function writeModelFile(filePath: string, model: string): void {
  const tmpPath = filePath + '.tmp';
  writeFileSync(tmpPath, JSON.stringify({ model }), 'utf8');
  renameSync(tmpPath, filePath);
}

export function readModelFile(filePath: string): string | null {
  try {
    const data = JSON.parse(readFileSync(filePath, 'utf8'));
    return data.model ?? null;
  } catch {
    return null;
  }
}
