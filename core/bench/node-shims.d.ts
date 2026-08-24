declare module 'node:fs' {
  export function writeFileSync(path: string, data: string, encoding: 'utf8'): void;
}

declare module 'node:perf_hooks' {
  export const performance: { now(): number };
  export class PerformanceObserver {
    constructor(
      callback: (list: { getEntries(): readonly { readonly duration: number }[] }) => void
    );
    observe(options: { readonly entryTypes: readonly string[] }): void;
    disconnect(): void;
  }
}

declare const process: {
  readonly argv: readonly string[];
  readonly version: string;
  readonly platform: string;
  memoryUsage(): { readonly heapUsed: number };
};
