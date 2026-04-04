type ShutdownCallback = () => Promise<void | unknown>;

interface ShutdownEntry {
  name: string;
  callback: ShutdownCallback;
}

export class ShutdownHandler {
  private readonly entries: ShutdownEntry[] = [];

  constructor(private readonly timeoutMs: number) {}

  register(name: string, callback: ShutdownCallback): void {
    this.entries.push({ name, callback });
  }

  async execute(): Promise<void> {
    const perHandlerTimeout = (name: string): Promise<void> =>
      new Promise<void>((resolve) =>
        setTimeout(() => {
          console.warn(`[ShutdownHandler] Timeout waiting for '${name}'`);
          resolve();
        }, this.timeoutMs)
      );

    const runOne = async (entry: ShutdownEntry): Promise<void> => {
      try {
        await Promise.race([entry.callback(), perHandlerTimeout(entry.name)]);
      } catch (err) {
        console.error(`[ShutdownHandler] Error in '${entry.name}':`, err);
      }
    };

    // Global budget: all handlers must finish within 2x the per-handler timeout.
    // This prevents N slow handlers from causing an N*timeout shutdown.
    const globalTimeout = new Promise<void>((resolve) =>
      setTimeout(() => {
        console.warn(`[ShutdownHandler] Global shutdown timeout reached — forcing exit`);
        resolve();
      }, this.timeoutMs * 2)
    );

    await Promise.race([
      Promise.all(this.entries.map(runOne)),
      globalTimeout,
    ]);
  }
}
