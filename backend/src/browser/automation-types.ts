/**
 * Automation Types
 *
 * Shared types for recorder, code generator, and test runner.
 */

// ============ ACTION RECORDING ============

export type RecordedActionType =
  | 'navigation'
  | 'click'
  | 'type'
  | 'fill'
  | 'select'
  | 'scroll'
  | 'hover'
  | 'wait'
  | 'assertion';

export interface RecordedAction {
  id: string;
  type: RecordedActionType;
  timestamp: number;

  // Navigation
  url?: string;

  // Interaction
  selector?: string;
  text?: string;
  value?: string | string[];
  button?: 'left' | 'right' | 'middle';

  // Scroll
  x?: number;
  y?: number;

  // Wait
  waitType?: 'selector' | 'navigation' | 'timeout';
  waitState?: 'attached' | 'detached' | 'visible' | 'hidden';
  timeout?: number;

  // Assertion
  assertionType?: 'visible' | 'hidden' | 'text' | 'value' | 'count';
  expected?: any;

  // Metadata
  element?: {
    tag: string;
    id?: string;
    classes?: string[];
    text?: string;
  };
}

export interface RecordingSession {
  id: string;
  sessionId: string; // Browser session ID
  actions: RecordedAction[];
  startTime: number;
  endTime?: number;
  status: 'recording' | 'stopped';
}

// ============ CODE GENERATION ============

export type CodeFramework = 'playwright' | 'puppeteer' | 'selenium';

export interface CodeGenerationOptions {
  framework: CodeFramework;
  language?: 'javascript' | 'typescript' | 'python';
  testFramework?: 'jest' | 'mocha' | 'pytest' | 'none';
  includeComments?: boolean;
  includeAssertions?: boolean;
}

export interface GeneratedCode {
  code: string;
  framework: CodeFramework;
  language: string;
}

// ============ SELECTOR GENERATION ============

export interface SelectorStrategy {
  type: 'data-testid' | 'id' | 'aria-label' | 'text' | 'css' | 'xpath';
  selector: string;
  priority: number;
}

export interface ElementContext {
  tag: string;
  id?: string;
  classes?: string[];
  text?: string;
  attributes?: Record<string, string>;
  parent?: ElementContext;
  index?: number;
}

// ============ TEST EXECUTION ============

export interface TestJob {
  id: string;
  runId: string;
  name: string;
  code: string;
  framework: CodeFramework;
  status: 'queued' | 'running' | 'passed' | 'failed' | 'error';
  startTime?: number;
  endTime?: number;
  duration?: number;
  error?: string;
  screenshot?: Buffer;
  logs: string[];
}

export interface TestRun {
  id: string;
  jobs: TestJob[];
  startTime: number;
  endTime?: number;
  status: 'running' | 'completed' | 'cancelled';
  summary: {
    total: number;
    passed: number;
    failed: number;
    error: number;
  };
}

// ============ COOKIES ============

export interface Cookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'Strict' | 'Lax' | 'None';
}

export interface CookieFilter {
  name?: string;
  domain?: string;
  path?: string;
}
