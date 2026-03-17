import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addProcessLog,
  associatePort,
  getProcessLogsByPortAfterCursor,
  registerProcess,
  removeProcess
} from './process-log-store';

describe('process-log-store', () => {
  const pid = 90321;
  const port = 5901;

  afterEach(() => {
    removeProcess(pid);
    vi.restoreAllMocks();
  });

  it('falls back to timestamp filtering when cursor id is no longer present', () => {
    let currentTime = 1000;
    vi.spyOn(Date, 'now').mockImplementation(() => currentTime);

    registerProcess(pid, 'npm run dev', 'C:/tmp');
    associatePort(pid, port);

    addProcessLog(pid, 'stdout', 'first');
    addProcessLog(pid, 'stdout', 'second');
    currentTime = 1001;
    addProcessLog(pid, 'stderr', 'third');

    const afterCursor = getProcessLogsByPortAfterCursor(port, {
      timestamp: 1000,
      id: 'missing-cursor-id'
    });

    expect(afterCursor.map((log) => log.data)).toEqual(['first', 'second', 'third']);
  });
});
