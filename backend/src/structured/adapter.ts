import type { CanonicalEvent } from './canonical-events';

/**
 * Describes what a provider can do.
 */
export interface ProviderCapabilities {
  supportsStreaming: boolean;
  supportsApproval: boolean;
  supportsInterrupt: boolean;
}

/**
 * Options passed to `ProviderAdapter.spawn()`.
 */
export interface SpawnOptions {
  prompt: string;
  cwd: string;
  sessionId?: string;
  model?: string;
  env?: Record<string, string>;
}

/**
 * A running CLI process that emits canonical events.
 */
export interface ProviderProcess {
  readonly events: AsyncIterable<CanonicalEvent>;
  sendInput(text: string): void;
  sendApproval(approved: boolean): void;
  interrupt(): void;
  kill(): void;
}

/**
 * Each CLI adapter implements this interface.
 */
export interface ProviderAdapter {
  readonly providerId: string;
  readonly capabilities: ProviderCapabilities;
  spawn(options: SpawnOptions): ProviderProcess;
}
