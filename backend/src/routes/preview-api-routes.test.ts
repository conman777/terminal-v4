import { afterEach, describe, expect, it } from 'vitest';
import { getWindowsSystemBinaryPath, parseWindowsListeningPorts } from './preview-api-routes';

describe('preview-api-routes Windows helpers', () => {
  const originalSystemRoot = process.env.SystemRoot;
  const originalWindir = process.env.WINDIR;

  afterEach(() => {
    process.env.SystemRoot = originalSystemRoot;
    process.env.WINDIR = originalWindir;
  });

  it('builds Windows system binary paths without relying on PATH', () => {
    process.env.SystemRoot = 'C:\\Windows';
    delete process.env.WINDIR;

    expect(getWindowsSystemBinaryPath('System32', 'netstat.exe')).toBe('C:\\Windows\\System32\\netstat.exe');
  });

  it('parses listening ports from Windows netstat output', () => {
    const stdout = [
      'Active Connections',
      '',
      '  Proto  Local Address          Foreign Address        State           PID',
      '  TCP    0.0.0.0:3020           0.0.0.0:0              LISTENING       11111',
      '  TCP    0.0.0.0:8081           0.0.0.0:0              LISTENING       22222',
      '  TCP    127.0.0.1:5173         0.0.0.0:0              LISTENING       33333',
      '  TCP    127.0.0.1:49999        127.0.0.1:8081         ESTABLISHED     44444',
    ].join('\r\n');

    const ports = parseWindowsListeningPorts(stdout);

    expect(Array.from(ports.keys()).sort((a, b) => a - b)).toEqual([5173, 8081]);
    expect(ports.get(8081)).toEqual({ process: '', cwd: null });
  });
});
