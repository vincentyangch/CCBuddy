// Ambient type declaration for @anthropic-ai/claude-code
// The package is a CLI tool with no official SDK module exports yet.
// This declaration provides the minimal `query` interface used by SdkBackend.
declare module '@anthropic-ai/claude-code' {
  export interface TextBlock {
    type: 'text';
    text: string;
  }

  export type ResultBlock = TextBlock | { type: string; [key: string]: unknown };

  export function query(
    prompt: string,
    options?: Record<string, unknown>,
  ): Promise<ResultBlock[]>;
}
