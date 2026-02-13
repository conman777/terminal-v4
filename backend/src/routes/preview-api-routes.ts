import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { exec } from 'node:child_process';
import { clearAllCookies, clearCookies, listCookies, hasCookies } from '../preview/cookie-store';
import { getProxyLogs, clearProxyLogs, getActivePreviewPorts } from '../preview/request-log-store';
import { getProcessLogsByPort } from '../preview/process-log-store';
import {
  clearPerformanceMetrics,
  getPerformanceMetrics,
  ingestPerformanceMetrics,
  subscribePerformanceMetrics
} from '../preview/performance-store';
import { clearWebSocketLogs, getWebSocketLogs } from '../preview/websocket-interceptor';
import {
  previewEvaluateRequestSchema,
  previewPerformanceIngestRequestSchema,
  previewStorageUpdateRequestSchema,
  previewWebSocketQuerySchema
} from './schemas';

// Rate limiter for eval endpoint
interface RateLimitEntry {
  count: number;
  resetTime: number;
}
const evalRateLimiter = new Map<string, RateLimitEntry>();
const ACTIVE_PORTS_CACHE_TTL_MS = (() => {
  const parsed = Number.parseInt(process.env.PREVIEW_ACTIVE_PORTS_CACHE_TTL_MS || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5000;
})();
const PREVIEW_LOG_STREAM_POLL_MS = (() => {
  const parsed = Number.parseInt(process.env.PREVIEW_LOG_STREAM_POLL_MS || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1000;
})();
const PREVIEW_PORT_PROBE_TIMEOUT_MS = (() => {
  const parsed = Number.parseInt(process.env.PREVIEW_PORT_PROBE_TIMEOUT_MS || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1500;
})();
const NON_PREVIEW_PROCESS_PREFIXES = [
  'chrome',
  'chromium',
  'firefox',
  'brave',
  'safari',
  'arc',
  'cups',
  'cupsd',
  'avahi',
  'systemd',
  'mdnsresponder',
  'dnsmasq',
  'ntpd',
  'sshd',
  'tailscaled',
  'containerd',
  'dockerd',
  'docker',
  'podman',
  'postgres',
  'mysqld',
  'redis-server',
  'mongod',
  'memcached',
  'rabbitmq',
  'elasticsearch',
  'kafka',
  'influxd'
];
const APP_PORT = (() => {
  const parsed = Number.parseInt(process.env.PORT || '3020', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 3020;
})();

interface ActivePortInfo {
  process: string;
  cwd: string | null;
}

interface WindowsListeningPortEntry {
  port: number;
  pid: number | null;
  process: string;
}

interface LinuxListeningPortEntry {
  port: number;
  pid: number | null;
  process: string;
}

interface ActivePortResponse {
  port: number;
  listening: boolean;
  previewed: boolean;
  previewable: boolean;
  probeStatus: 'html' | 'redirect' | 'reachable-non-html' | 'unreachable' | 'timeout' | 'excluded-process';
  reachable: boolean;
  frontendLikely: boolean;
  common: boolean;
  process: string | null;
  cwd: string | null;
}

interface PortProbeResult {
  probeStatus: ActivePortResponse['probeStatus'];
  reachable: boolean;
  frontendLikely: boolean;
  previewable: boolean;
}

let activePortsCache: { expiresAt: number; ports: ActivePortResponse[] } | null = null;
let activePortsInFlight: Promise<ActivePortResponse[]> | null = null;

// Clean up old rate limit entries every 5 minutes
const evalRateLimiterCleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of evalRateLimiter.entries()) {
    if (entry.resetTime < now) {
      evalRateLimiter.delete(key);
    }
  }
}, 5 * 60 * 1000);
evalRateLimiterCleanupInterval.unref?.();

function toCwdScope(cwdPath: string | null | undefined): string | null {
  if (!cwdPath || typeof cwdPath !== 'string') return null;
  const normalized = cwdPath.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!normalized) return null;
  const parts = normalized.split('/').filter(Boolean);
  return parts[parts.length - 1] || normalized;
}

function normalizeWindowsProcessName(processName: string): string {
  const trimmed = processName.trim();
  if (!trimmed) return '';
  return trimmed.toLowerCase().endsWith('.exe')
    ? trimmed.slice(0, -4)
    : trimmed;
}

function parseWindowsPowerShellListeningEntries(stdout: string): WindowsListeningPortEntry[] {
  if (!stdout || !stdout.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const entries: WindowsListeningPortEntry[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const localPortRaw = (row as Record<string, unknown>).LocalPort;
    const owningProcessRaw = (row as Record<string, unknown>).OwningProcess;
    const processNameRaw = (row as Record<string, unknown>).ProcessName;

    const port = Number.parseInt(String(localPortRaw ?? ''), 10);
    if (!Number.isFinite(port) || port < 1 || port > 65535 || port === APP_PORT) continue;

    const pidParsed = Number.parseInt(String(owningProcessRaw ?? ''), 10);
    const pid = Number.isFinite(pidParsed) && pidParsed > 0 ? pidParsed : null;
    const processName = typeof processNameRaw === 'string'
      ? normalizeWindowsProcessName(processNameRaw)
      : '';

    entries.push({ port, pid, process: processName });
  }
  return entries;
}

function parseWindowsNetstatListeningEntries(stdout: string): WindowsListeningPortEntry[] {
  if (!stdout || !stdout.trim()) return [];
  const entries: WindowsListeningPortEntry[] = [];
  const seenPorts = new Set<number>();
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)$/i);
    if (!match) continue;

    const port = Number.parseInt(match[1], 10);
    if (!Number.isFinite(port) || port < 1 || port > 65535 || port === APP_PORT) continue;
    if (seenPorts.has(port)) continue;
    seenPorts.add(port);

    const pidParsed = Number.parseInt(match[2], 10);
    const pid = Number.isFinite(pidParsed) && pidParsed > 0 ? pidParsed : null;
    entries.push({ port, pid, process: '' });
  }
  return entries;
}

function parseWindowsTasklistProcessMap(stdout: string): Map<number, string> {
  const processByPid = new Map<number, string>();
  if (!stdout || !stdout.trim()) return processByPid;
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^"([^"]+)","(\d+)"/);
    if (!match) continue;
    const pid = Number.parseInt(match[2], 10);
    if (!Number.isFinite(pid) || pid <= 0) continue;
    processByPid.set(pid, normalizeWindowsProcessName(match[1]));
  }
  return processByPid;
}

function createActivePortMapFromWindowsEntries(entries: WindowsListeningPortEntry[]): Map<number, ActivePortInfo> {
  const portMap = new Map<number, ActivePortInfo>();
  for (const entry of entries) {
    if (!Number.isFinite(entry.port) || entry.port < 1 || entry.port > 65535 || entry.port === APP_PORT) continue;
    const processName = normalizeWindowsProcessName(entry.process || '');
    const existing = portMap.get(entry.port);
    if (!existing) {
      portMap.set(entry.port, { process: processName, cwd: null });
      continue;
    }
    if (!existing.process && processName) {
      existing.process = processName;
    }
  }
  return portMap;
}

async function lookupWindowsProcessNamesForPids(pids: number[]): Promise<Map<number, string>> {
  if (pids.length === 0) return new Map();
  return new Promise((resolve) => {
    exec('tasklist /FO CSV /NH', { maxBuffer: 10 * 1024 * 1024 }, (error, stdout) => {
      if (error || !stdout) {
        resolve(new Map());
        return;
      }
      const allProcesses = parseWindowsTasklistProcessMap(stdout);
      const filtered = new Map<number, string>();
      for (const pid of pids) {
        const name = allProcesses.get(pid);
        if (name) {
          filtered.set(pid, name);
        }
      }
      resolve(filtered);
    });
  });
}

async function scanWindowsListeningPorts(): Promise<Map<number, ActivePortInfo>> {
  const powerShellCommand = [
    'powershell',
    '-NoProfile',
    '-Command',
    '"Get-NetTCPConnection -State Listen',
    "| Select-Object LocalPort,OwningProcess,@{Name='ProcessName';Expression={(Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName}}",
    '| ConvertTo-Json -Compress"'
  ].join(' ');

  const powerShellEntries = await new Promise<WindowsListeningPortEntry[]>((resolve) => {
    exec(powerShellCommand, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout) => {
      if (error || !stdout) {
        resolve([]);
        return;
      }
      resolve(parseWindowsPowerShellListeningEntries(stdout));
    });
  });

  if (powerShellEntries.length > 0) {
    return createActivePortMapFromWindowsEntries(powerShellEntries);
  }

  const netstatEntries = await new Promise<WindowsListeningPortEntry[]>((resolve) => {
    exec('netstat -ano -p tcp', { maxBuffer: 10 * 1024 * 1024 }, (error, stdout) => {
      if (error || !stdout) {
        resolve([]);
        return;
      }
      resolve(parseWindowsNetstatListeningEntries(stdout));
    });
  });

  if (netstatEntries.length === 0) {
    return new Map();
  }

  const missingProcessPids = Array.from(new Set(
    netstatEntries
      .map((entry) => entry.pid)
      .filter((pid): pid is number => Number.isFinite(pid) && pid > 0)
  ));
  const processByPid = await lookupWindowsProcessNamesForPids(missingProcessPids);
  const enrichedEntries = netstatEntries.map((entry) => {
    if (entry.process) return entry;
    const processName = entry.pid ? processByPid.get(entry.pid) || '' : '';
    return { ...entry, process: processName };
  });

  return createActivePortMapFromWindowsEntries(enrichedEntries);
}

function parseLinuxSsListeningEntries(stdout: string): LinuxListeningPortEntry[] {
  if (!stdout || !stdout.trim()) return [];
  const entries: LinuxListeningPortEntry[] = [];
  for (const line of stdout.trim().split('\n')) {
    const portMatch = line.match(/[:\s](\d+)\s+[\d\.\*:\[\]]+:\*/);
    if (!portMatch) continue;
    const port = Number.parseInt(portMatch[1], 10);
    if (!Number.isFinite(port) || port < 1 || port > 65535 || port === APP_PORT) continue;

    const processMatch = line.match(/users:\(\("([^"]+)",pid=(\d+)/);
    const processName = processMatch ? processMatch[1] : '';
    const pidParsed = processMatch ? Number.parseInt(processMatch[2], 10) : Number.NaN;
    const pid = Number.isFinite(pidParsed) && pidParsed > 0 ? pidParsed : null;
    entries.push({ port, pid, process: processName });
  }
  return entries;
}

function parseLinuxNetstatListeningEntries(stdout: string): LinuxListeningPortEntry[] {
  if (!stdout || !stdout.trim()) return [];
  const entries: LinuxListeningPortEntry[] = [];
  for (const line of stdout.trim().split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const portMatch = trimmed.match(/[:\s](\d+)\s+\S+\s+LISTEN/i);
    if (!portMatch) continue;
    const port = Number.parseInt(portMatch[1], 10);
    if (!Number.isFinite(port) || port < 1 || port > 65535 || port === APP_PORT) continue;

    const pidProcessMatch = trimmed.match(/\s(\d+)\/([^\s]+)\s*$/);
    const pidParsed = pidProcessMatch ? Number.parseInt(pidProcessMatch[1], 10) : Number.NaN;
    const pid = Number.isFinite(pidParsed) && pidParsed > 0 ? pidParsed : null;
    const process = pidProcessMatch ? pidProcessMatch[2] : '';
    entries.push({ port, pid, process });
  }
  return entries;
}

async function buildLinuxPortMap(entries: LinuxListeningPortEntry[]): Promise<Map<number, ActivePortInfo>> {
  const portMap = new Map<number, ActivePortInfo>();
  const cwdPromises: Promise<void>[] = [];

  for (const entry of entries) {
    if (!portMap.has(entry.port)) {
      portMap.set(entry.port, { process: entry.process, cwd: null });
    }
    if (entry.pid) {
      const cwdPromise = (async () => {
        try {
          const { readlink } = await import('fs/promises');
          const cwd = await readlink(`/proc/${entry.pid}/cwd`);
          if (!cwd) return;
          const dirName = toCwdScope(cwd);
          if (!dirName) return;
          const existing = portMap.get(entry.port);
          if (existing) {
            existing.cwd = dirName;
          }
        } catch {
          // Process may exit while scanning.
        }
      })();
      cwdPromises.push(cwdPromise);
    }
  }

  await Promise.all(cwdPromises);
  return portMap;
}

async function lookupDarwinProcessCwd(pid: number): Promise<string | null> {
  if (!Number.isFinite(pid) || pid <= 0) return null;
  return new Promise((resolve) => {
    exec(`lsof -a -p ${pid} -d cwd -Fn 2>/dev/null`, (error, stdout) => {
      if (error || !stdout) {
        resolve(null);
        return;
      }
      const cwdLine = stdout
        .split('\n')
        .map((line) => line.trim())
        .find((line) => line.startsWith('n'));
      if (!cwdLine || cwdLine.length <= 1) {
        resolve(null);
        return;
      }
      resolve(toCwdScope(cwdLine.slice(1).trim()));
    });
  });
}

async function scanListeningPorts(): Promise<Map<number, ActivePortInfo>> {
  if (process.platform === 'win32') {
    return scanWindowsListeningPorts();
  }

  if (process.platform === 'darwin') {
    return new Promise((resolve) => {
      exec('lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null', (error, stdout) => {
        const portMap = new Map<number, ActivePortInfo>();
        if (error) {
          resolve(portMap);
          return;
        }
        const lines = stdout.trim().split('\n').slice(1);
        const cwdPromises: Promise<void>[] = [];
        for (const line of lines) {
          const match = line.match(/^(\S+)\s+(\d+)\s+\S+.*TCP\s+\S+:(\d+)\s+\(LISTEN\)\s*$/);
          if (!match) continue;
          const processName = match[1];
          const pid = Number.parseInt(match[2], 10);
          const port = Number.parseInt(match[3], 10);
          if (!Number.isFinite(port) || port < 1 || port > 65535 || port === APP_PORT) continue;
          if (!portMap.has(port)) {
            portMap.set(port, { process: processName, cwd: null });
          }
          if (Number.isFinite(pid) && pid > 0) {
            const cwdPromise = lookupDarwinProcessCwd(pid).then((cwd) => {
              if (!cwd) return;
              const existing = portMap.get(port);
              if (existing && !existing.cwd) {
                existing.cwd = cwd;
              }
            });
            cwdPromises.push(cwdPromise);
          }
        }
        Promise.all(cwdPromises)
          .then(() => resolve(portMap))
          .catch(() => resolve(portMap));
      });
    });
  }

  return new Promise((resolve) => {
    exec('ss -tlnp 2>/dev/null | grep LISTEN', async (error, stdout) => {
      const ssEntries = error ? [] : parseLinuxSsListeningEntries(stdout);
      if (ssEntries.length > 0) {
        resolve(await buildLinuxPortMap(ssEntries));
        return;
      }

      exec('netstat -tlnp 2>/dev/null | grep LISTEN', async (netstatError, netstatStdout) => {
        if (netstatError || !netstatStdout) {
          resolve(new Map());
          return;
        }
        const netstatEntries = parseLinuxNetstatListeningEntries(netstatStdout);
        if (netstatEntries.length === 0) {
          resolve(new Map());
          return;
        }
        resolve(await buildLinuxPortMap(netstatEntries));
      });
    });
  });
}

export const __previewApiRoutesTestUtils = {
  parseWindowsPowerShellListeningEntries,
  parseWindowsNetstatListeningEntries,
  parseWindowsTasklistProcessMap,
  parseLinuxSsListeningEntries,
  parseLinuxNetstatListeningEntries
};

async function listActivePortsSnapshot(): Promise<ActivePortResponse[]> {
  const now = Date.now();
  if (activePortsCache && activePortsCache.expiresAt > now) {
    return activePortsCache.ports;
  }
  if (activePortsInFlight) {
    return activePortsInFlight;
  }

  activePortsInFlight = (async () => {
    const previewedPorts = getActivePreviewPorts();
    const portInfo = await scanListeningPorts();
    const listeningPorts = Array.from(portInfo.keys());
    const listeningSet = new Set(listeningPorts);
    const previewedSet = new Set(previewedPorts);
    const commonDevPorts = [3000, 3001, 3002, 3003, 4000, 5000, 5173, 5174, 8000, 8080, 8885, 8888];
    const allPorts = [...new Set([...previewedPorts, ...listeningPorts])].sort((a, b) => a - b);
    const probeByPort = new Map<number, PortProbeResult>();

    await Promise.all(allPorts.map(async (port) => {
      if (!listeningSet.has(port)) {
        probeByPort.set(port, {
          probeStatus: 'unreachable',
          reachable: false,
          frontendLikely: false,
          previewable: false
        });
        return;
      }
      const processName = portInfo.get(port)?.process;
      if (isExcludedProcessForPreview(processName)) {
        probeByPort.set(port, {
          probeStatus: 'excluded-process',
          reachable: false,
          frontendLikely: false,
          previewable: false
        });
        return;
      }
      probeByPort.set(port, await probePortPreviewability(port));
    }));

    const ports = allPorts.map((port) => {
      const info = portInfo.get(port);
      const probe = probeByPort.get(port) || {
        probeStatus: 'unreachable',
        reachable: false,
        frontendLikely: false,
        previewable: false
      };
      return {
        port,
        listening: listeningSet.has(port),
        previewed: previewedSet.has(port),
        previewable: probe.previewable,
        probeStatus: probe.probeStatus,
        reachable: probe.reachable,
        frontendLikely: probe.frontendLikely,
        common: commonDevPorts.includes(port),
        process: info?.process || null,
        cwd: info?.cwd || null
      };
    });

    activePortsCache = {
      expiresAt: Date.now() + ACTIVE_PORTS_CACHE_TTL_MS,
      ports
    };
    return ports;
  })();

  try {
    return await activePortsInFlight;
  } finally {
    activePortsInFlight = null;
  }
}

function isLikelyPreviewContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  const normalized = contentType.toLowerCase();
  return normalized.includes('text/html') || normalized.includes('application/xhtml+xml');
}

function isLikelyApiOnlyPath(pathname: string): boolean {
  const normalized = pathname.toLowerCase();
  return (
    normalized === '/api' ||
    normalized.startsWith('/api/') ||
    normalized === '/graphql' ||
    normalized.startsWith('/graphql/') ||
    normalized === '/openapi' ||
    normalized.startsWith('/openapi') ||
    normalized.startsWith('/swagger') ||
    normalized === '/health' ||
    normalized.startsWith('/health/') ||
    normalized === '/metrics' ||
    normalized.startsWith('/metrics/') ||
    normalized === '/status' ||
    normalized.startsWith('/status/') ||
    /^\/v\d+\/(api|graphql|health|metrics)/.test(normalized)
  );
}

async function probePortPreviewability(port: number): Promise<PortProbeResult> {
  const hosts = ['127.0.0.1', 'localhost'];
  let sawReachable = false;
  let sawTimeout = false;
  for (const host of hosts) {
    try {
      const response = await fetch(`http://${host}:${port}/`, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(PREVIEW_PORT_PROBE_TIMEOUT_MS),
        headers: {
          Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1'
        }
      });

      if (response.status >= 300 && response.status < 400 && response.headers.has('location')) {
        sawReachable = true;
        const location = response.headers.get('location');
        if (!location) continue;

        try {
          const redirectUrl = new URL(location, `http://${host}:${port}`);
          if (isLikelyApiOnlyPath(redirectUrl.pathname)) {
            continue;
          }
        } catch {
          // Unparseable redirect target; keep probing fallback host.
          continue;
        }

        return {
          probeStatus: 'redirect',
          reachable: true,
          frontendLikely: true,
          previewable: true
        };
      }

      sawReachable = true;
      if (isLikelyPreviewContentType(response.headers.get('content-type'))) {
        return {
          probeStatus: 'html',
          reachable: true,
          frontendLikely: true,
          previewable: true
        };
      }
    } catch (error) {
      const errorName = error && typeof error === 'object' && 'name' in error ? String((error as { name?: unknown }).name) : '';
      const errorMessage = error instanceof Error ? error.message : '';
      if (errorName === 'TimeoutError' || errorName === 'AbortError' || /timed?\s*out/i.test(errorMessage)) {
        sawTimeout = true;
      }
    }
  }
  if (sawReachable) {
    return {
      probeStatus: 'reachable-non-html',
      reachable: true,
      frontendLikely: false,
      previewable: false
    };
  }
  if (sawTimeout) {
    return {
      probeStatus: 'timeout',
      reachable: false,
      frontendLikely: false,
      previewable: false
    };
  }
  return {
    probeStatus: 'unreachable',
    reachable: false,
    frontendLikely: false,
    previewable: false
  };
}

function isExcludedProcessForPreview(processName: string | null | undefined): boolean {
  if (!processName) return false;
  const normalized = processName.toLowerCase();
  return NON_PREVIEW_PROCESS_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function parsePreviewPort(portValue: string): number | null {
  const port = Number.parseInt(portValue, 10);
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    return null;
  }
  return port;
}

function buildRequestId(prefix: string): string {
  const randomPart = Math.random().toString(36).slice(2, 10);
  return `${prefix}-${Date.now()}-${randomPart}`;
}

function applyPreviewCorsHeaders(request: FastifyRequest, reply: FastifyReply): void {
  const origin = request.headers.origin;
  if (!origin) return;
  reply.header('Access-Control-Allow-Origin', origin);
  reply.header('Access-Control-Allow-Credentials', 'true');
  reply.header('Vary', 'Origin');
}

export async function registerPreviewApiRoutes(app: FastifyInstance): Promise<void> {
  // Preview: Clear stored cookies across all ports
  app.delete('/api/preview/cookies', async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }
    const clearedPorts = clearAllCookies();
    reply.send({ success: true, clearedPorts });
  });

  // Preview: Get stored cookies for a port
  app.get<{ Params: { port: string } }>('/api/preview/:port/cookies', async (request, reply) => {
    const port = parsePreviewPort(request.params.port);
    if (!port) {
      reply.code(400).send({ error: 'Invalid port number' });
      return;
    }
    reply.send({
      port,
      hasCookies: hasCookies(port),
      cookies: listCookies(port)
    });
  });

  // Preview: Clear stored cookies for a port
  app.delete<{ Params: { port: string } }>('/api/preview/:port/cookies', async (request, reply) => {
    const port = parsePreviewPort(request.params.port);
    if (!port) {
      reply.code(400).send({ error: 'Invalid port number' });
      return;
    }
    clearCookies(port);
    reply.send({ success: true, port });
  });

  // Preview: Get server-side proxy request logs for a port
  app.get<{ Params: { port: string }; Querystring: { since?: string } }>('/api/preview/:port/proxy-logs', async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }
    const port = parsePreviewPort(request.params.port);
    if (!port) {
      reply.code(400).send({ error: 'Invalid port number' });
      return;
    }
    const since = request.query.since ? Number.parseInt(request.query.since, 10) : undefined;
    const logs = getProxyLogs(port, since);
    reply.send({ port, logs });
  });

  // Preview: Clear server-side proxy logs for a port
  app.delete<{ Params: { port: string } }>('/api/preview/:port/proxy-logs', async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }
    const port = parsePreviewPort(request.params.port);
    if (!port) {
      reply.code(400).send({ error: 'Invalid port number' });
      return;
    }
    clearProxyLogs(port);
    reply.send({ success: true, port });
  });

  // Preview: List active/available ports for preview
  app.get('/api/preview/active-ports', async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }

    const ports = await listActivePortsSnapshot();
    reply.send({ ports });
  });

  app.get<{ Params: { port: string }; Querystring: { since?: string; types?: string } }>(
    '/api/preview/:port/log-stream',
    async (request, reply) => {
      const userId = request.userId;
      if (!userId) {
        reply.code(401).send({ error: 'Unauthorized' });
        return;
      }

      const port = parsePreviewPort(request.params.port);
      if (!port) {
        reply.code(400).send({ error: 'Invalid port number' });
        return;
      }

      const parsedSince = request.query.since ? Number.parseInt(request.query.since, 10) : 0;
      const since = Number.isFinite(parsedSince) && parsedSince > 0 ? parsedSince : 0;
      const requestedTypes = (request.query.types || 'proxy,server')
        .split(',')
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean);
      const includeProxy = requestedTypes.length === 0 || requestedTypes.includes('proxy');
      const includeServer = requestedTypes.length === 0 || requestedTypes.includes('server');

      reply.hijack();
      const stream = reply.raw;
      stream.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'
      });
      if (typeof (stream as { flushHeaders?: () => void }).flushHeaders === 'function') {
        (stream as { flushHeaders: () => void }).flushHeaders();
      }

      let closed = false;
      let proxyCursor = since;
      let processCursor = since;
      const sendEvent = (eventName: string, payload: unknown): void => {
        if (closed) return;
        try {
          stream.write(`event: ${eventName}\n`);
          stream.write(`data: ${JSON.stringify(payload)}\n\n`);
        } catch {
          closed = true;
        }
      };

      const flushLogs = () => {
        if (closed) return;
        if (includeProxy) {
          const proxyLogs = getProxyLogs(port, proxyCursor);
          for (const entry of proxyLogs) {
            sendEvent('proxy', entry);
            proxyCursor = Math.max(proxyCursor, entry.timestamp);
          }
        }
        if (includeServer) {
          const processLogs = getProcessLogsByPort(port, processCursor);
          for (const entry of processLogs) {
            sendEvent('server', entry);
            processCursor = Math.max(processCursor, entry.timestamp);
          }
        }
      };

      flushLogs();
      const pollTimer = setInterval(flushLogs, PREVIEW_LOG_STREAM_POLL_MS);
      const keepAlive = setInterval(() => {
        if (closed) return;
        sendEvent('ping', { ts: Date.now() });
      }, 15000);

      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(pollTimer);
        clearInterval(keepAlive);
      };

      stream.on('close', cleanup);
      stream.on('error', cleanup);
      request.raw.on('close', cleanup);
    }
  );

  app.options('/api/preview/:port/performance', {
    config: { skipAuth: true }
  }, async (request, reply) => {
    applyPreviewCorsHeaders(request, reply);
    reply.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
    reply.header('Access-Control-Allow-Headers', 'content-type, authorization');
    reply.code(204).send();
  });

  app.post<{ Params: { port: string }; Body: unknown }>('/api/preview/:port/performance', {
    config: { skipAuth: true },
    preHandler: async (request, reply) => {
      applyPreviewCorsHeaders(request, reply);
    }
  }, async (request, reply) => {
    const port = parsePreviewPort(request.params.port);
    if (!port) {
      reply.code(400).send({ error: 'Invalid port number' });
      return;
    }

    const parsedBody = previewPerformanceIngestRequestSchema.safeParse(request.body);
    if (!parsedBody.success) {
      reply.code(400).send({
        error: 'Invalid metrics payload',
        issues: parsedBody.error.issues.map((issue) => issue.message)
      });
      return;
    }

    const result = ingestPerformanceMetrics(port, parsedBody.data.metrics);
    reply.send({
      success: true,
      port,
      accepted: result.accepted,
      rejected: result.rejected
    });
  });

  app.get<{ Params: { port: string } }>('/api/preview/:port/performance', async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }
    const port = parsePreviewPort(request.params.port);
    if (!port) {
      reply.code(400).send({ error: 'Invalid port number' });
      return;
    }
    reply.send({
      port,
      metrics: getPerformanceMetrics(port)
    });
  });

  app.delete<{ Params: { port: string } }>('/api/preview/:port/performance', async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }
    const port = parsePreviewPort(request.params.port);
    if (!port) {
      reply.code(400).send({ error: 'Invalid port number' });
      return;
    }
    const cleared = clearPerformanceMetrics(port);
    reply.send({ success: true, port, cleared });
  });

  app.get('/api/preview/:port/performance/stream', { websocket: true }, (socket, request) => {
    const userId = request.userId;
    if (!userId) {
      socket.close(4401, 'Unauthorized');
      return;
    }

    const port = parsePreviewPort((request.params as { port?: string }).port || '');
    if (!port) {
      socket.close(1008, 'Invalid preview port');
      return;
    }

    const sendMessage = (payload: unknown): void => {
      if (socket.readyState !== 1) return;
      try {
        socket.send(JSON.stringify(payload));
      } catch {
        // Best effort stream.
      }
    };

    sendMessage({
      type: 'performance-snapshot',
      metrics: getPerformanceMetrics(port)
    });

    const unsubscribe = subscribePerformanceMetrics(port, (metrics) => {
      sendMessage({
        type: 'performance-update',
        metrics
      });
    });

    socket.on('close', unsubscribe);
    socket.on('error', unsubscribe);
  });

  app.get<{ Params: { port: string }; Querystring: { connectionId?: string; direction?: string } }>(
    '/api/preview/:port/websockets',
    async (request, reply) => {
      const userId = request.userId;
      if (!userId) {
        reply.code(401).send({ error: 'Unauthorized' });
        return;
      }
      const port = parsePreviewPort(request.params.port);
      if (!port) {
        reply.code(400).send({ error: 'Invalid port number' });
        return;
      }

      const parsedQuery = previewWebSocketQuerySchema.safeParse(request.query || {});
      if (!parsedQuery.success) {
        reply.code(400).send({
          error: 'Invalid websocket query',
          issues: parsedQuery.error.issues.map((issue) => issue.message)
        });
        return;
      }

      const { connections, messages } = getWebSocketLogs(port, parsedQuery.data);
      reply.send({
        port,
        connections,
        messages
      });
    }
  );

  app.delete<{ Params: { port: string } }>('/api/preview/:port/websockets', async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }
    const port = parsePreviewPort(request.params.port);
    if (!port) {
      reply.code(400).send({ error: 'Invalid port number' });
      return;
    }
    const cleared = clearWebSocketLogs(port);
    reply.send({ success: true, port, cleared });
  });

  // Preview: Evaluate JavaScript in preview context (REPL)
  app.post<{ Params: { port: string }; Body: unknown }>('/api/preview/:port/evaluate', async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }
    const port = parsePreviewPort(request.params.port);
    if (!port) {
      reply.code(400).send({ error: 'Invalid port number' });
      return;
    }
    const parsedBody = previewEvaluateRequestSchema.safeParse(request.body);
    if (!parsedBody.success) {
      reply.code(400).send({
        error: 'Invalid expression',
        issues: parsedBody.error.issues.map((issue) => issue.message)
      });
      return;
    }
    const expression = parsedBody.data.expression;
    const requestId = parsedBody.data.requestId || buildRequestId('eval');

    // Rate limiting: 10 requests per minute per user.
    const clientId = `${userId}:${request.ip || 'unknown'}`;
    const now = Date.now();
    const limiter = evalRateLimiter.get(clientId);

    if (limiter && limiter.resetTime > now) {
      if (limiter.count >= 10) {
        app.log.warn({
          userId,
          clientIp: request.ip,
          port,
          rateLimitCount: limiter.count
        }, 'Rate limit exceeded for eval endpoint');
        reply.code(429).send({ error: 'Rate limit exceeded (10 requests per minute)' });
        return;
      }
      limiter.count++;
    } else {
      evalRateLimiter.set(clientId, { count: 1, resetTime: now + 60000 });
    }

    // Audit logging
    app.log.info({
      userId,
      clientIp: request.ip,
      port,
      expressionLength: expression.length,
      expressionPreview: expression.substring(0, 100)
    }, 'REPL evaluation requested');

    reply.send({
      success: true,
      requestId,
      port,
      mode: 'client-runtime'
    });
  });

  // Preview: Get storage (localStorage, sessionStorage, cookies)
  app.get<{ Params: { port: string } }>('/api/preview/:port/storage', async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }
    const port = parsePreviewPort(request.params.port);
    if (!port) {
      reply.code(400).send({ error: 'Invalid port number' });
      return;
    }

    reply.send({
      success: true,
      requestId: buildRequestId('storage-snapshot'),
      port,
      message: 'Storage snapshot should be requested from the preview runtime.'
    });
  });

  // Preview: Update storage (set/remove/clear)
  app.post<{ Params: { port: string }; Body: unknown }>(
    '/api/preview/:port/storage',
    async (request, reply) => {
      const userId = request.userId;
      if (!userId) {
        reply.code(401).send({ error: 'Unauthorized' });
        return;
      }
      const port = parsePreviewPort(request.params.port);
      if (!port) {
        reply.code(400).send({ error: 'Invalid port number' });
        return;
      }
      const parsedBody = previewStorageUpdateRequestSchema.safeParse(request.body);
      if (!parsedBody.success) {
        reply.code(400).send({
          error: 'Invalid storage operation',
          issues: parsedBody.error.issues.map((issue) => issue.message)
        });
        return;
      }

      const requestId = parsedBody.data.requestId || buildRequestId('storage');
      reply.send({
        success: true,
        requestId,
        port,
        operation: parsedBody.data.operation,
        storageType: parsedBody.data.type,
        mode: 'client-runtime'
      });
    }
  );
}
