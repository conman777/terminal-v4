import type { FastifyInstance } from 'fastify';
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { monitorEventLoopDelay } from 'node:perf_hooks';

// Stats history storage
const HISTORY_FILE = path.join(os.homedir(), '.terminal-v4-stats-history.json');
const HISTORY_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const HISTORY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const PREVIEW_SUBDOMAIN_BASES = (process.env.PREVIEW_SUBDOMAIN_BASES || process.env.PREVIEW_SUBDOMAIN_BASE || 'conordart.com,localhost')
  .split(',')
  .map((host) => host.trim())
  .filter(Boolean);
const PREVIEW_SUBDOMAIN_BASE = PREVIEW_SUBDOMAIN_BASES[0] || 'conordart.com';
const PREVIEW_PROXY_HOSTS = (process.env.PREVIEW_PROXY_HOSTS || 'localhost,127.0.0.1,::1')
  .split(',')
  .map((host) => host.trim())
  .filter(Boolean);
type PreviewDefaultMode = 'subdomain-first' | 'adaptive' | 'path-first';
type PreviewCookiePolicy = 'preserve-upstream' | 'compat-rewrite' | 'force-none';
type PreviewRewriteScope = 'minimal' | 'hybrid' | 'legacy';

function parsePreviewDefaultMode(value: string | undefined): PreviewDefaultMode {
  if (value === 'adaptive' || value === 'path-first') return value;
  return 'subdomain-first';
}

function parsePreviewCookiePolicy(value: string | undefined): PreviewCookiePolicy {
  if (value === 'compat-rewrite' || value === 'force-none') return value;
  return 'preserve-upstream';
}

function parsePreviewRewriteScope(value: string | undefined): PreviewRewriteScope {
  if (value === 'hybrid' || value === 'legacy') return value;
  return 'minimal';
}

const PREVIEW_DEFAULT_MODE = parsePreviewDefaultMode(process.env.PREVIEW_DEFAULT_MODE);
const PREVIEW_COOKIE_POLICY = parsePreviewCookiePolicy(process.env.PREVIEW_COOKIE_POLICY);
const PREVIEW_REWRITE_SCOPE = parsePreviewRewriteScope(process.env.PREVIEW_REWRITE_SCOPE);

interface StatsHistoryPoint {
  timestamp: number;
  cpu: number;
  memory: number;
  diskRead: number;   // MB/s
  diskWrite: number;  // MB/s
}

let statsHistory: StatsHistoryPoint[] = [];
let historyInterval: NodeJS.Timeout | null = null;
const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
eventLoopDelay.enable();

function loadStatsHistory(): void {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const data = fs.readFileSync(HISTORY_FILE, 'utf-8');
      statsHistory = JSON.parse(data);
      // Prune old entries
      const cutoff = Date.now() - HISTORY_MAX_AGE_MS;
      statsHistory = statsHistory.filter(p => p.timestamp > cutoff);
    }
  } catch {
    statsHistory = [];
  }
}

function saveStatsHistory(): void {
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(statsHistory), 'utf-8');
  } catch {
    // Ignore write errors
  }
}

async function collectStatsPoint(): Promise<void> {
  try {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const memoryPct = Math.round((usedMem / totalMem) * 100);

    // Quick CPU sample
    const getCpuTimes = () => os.cpus().map(cpu => ({
      idle: cpu.times.idle,
      total: Object.values(cpu.times).reduce((a, b) => a + b, 0)
    }));

    const startTimes = getCpuTimes();
    await new Promise(resolve => setTimeout(resolve, 100));
    const endTimes = getCpuTimes();

    const cpuUsage = startTimes.reduce((acc, start, i) => {
      const end = endTimes[i];
      const idleDiff = end.idle - start.idle;
      const totalDiff = end.total - start.total;
      return acc + (totalDiff > 0 ? ((totalDiff - idleDiff) / totalDiff) * 100 : 0);
    }, 0) / startTimes.length;

    // Calculate disk I/O (uses separate 100ms sample)
    const diskIO = await calculateDiskIO();

    const point: StatsHistoryPoint = {
      timestamp: Date.now(),
      cpu: Math.round(cpuUsage),
      memory: memoryPct,
      diskRead: diskIO.readMBps,
      diskWrite: diskIO.writeMBps
    };

    statsHistory.push(point);

    // Prune old entries
    const cutoff = Date.now() - HISTORY_MAX_AGE_MS;
    statsHistory = statsHistory.filter(p => p.timestamp > cutoff);

    saveStatsHistory();
  } catch {
    // Ignore collection errors
  }
}

interface DiskStats {
  sectorsRead: number;
  sectorsWrite: number;
}

/**
 * Read /proc/diskstats and aggregate stats for all real block devices.
 * Returns total sectors read and written across all devices.
 */
function readDiskStats(): DiskStats | null {
  try {
    const data = fs.readFileSync('/proc/diskstats', 'utf-8');
    let totalRead = 0;
    let totalWrite = 0;

    for (const line of data.split('\n')) {
      if (!line.trim()) continue;

      const parts = line.trim().split(/\s+/);
      if (parts.length < 14) continue;

      const deviceName = parts[2];

      // Filter to real block devices (exclude loop, ram, dm-)
      // Include: sda, sdb, nvme0n1, vda, xvda, hda
      if (!deviceName.match(/^(sd[a-z]+|nvme\d+n\d+|vd[a-z]+|xvd[a-z]+|hd[a-z]+)$/)) {
        continue;
      }

      // Column 6 = sectors read, Column 10 = sectors written (0-indexed: 5 and 9)
      const sectorsRead = parseInt(parts[5], 10);
      const sectorsWritten = parseInt(parts[9], 10);

      if (!isNaN(sectorsRead)) totalRead += sectorsRead;
      if (!isNaN(sectorsWritten)) totalWrite += sectorsWritten;
    }

    return { sectorsRead: totalRead, sectorsWrite: totalWrite };
  } catch {
    return null;
  }
}

/**
 * Calculate disk I/O rates by sampling /proc/diskstats twice.
 * Returns read and write rates in MB/s.
 */
async function calculateDiskIO(): Promise<{ readMBps: number; writeMBps: number }> {
  const start = readDiskStats();
  if (!start) return { readMBps: 0, writeMBps: 0 };

  await new Promise(resolve => setTimeout(resolve, 100));

  const end = readDiskStats();
  if (!end) return { readMBps: 0, writeMBps: 0 };

  // Calculate deltas (handle counter wrap-around)
  let readDelta = end.sectorsRead - start.sectorsRead;
  let writeDelta = end.sectorsWrite - start.sectorsWrite;

  // Ignore negative deltas (counter reset or device removal)
  if (readDelta < 0) readDelta = 0;
  if (writeDelta < 0) writeDelta = 0;

  // Convert to bytes/sec: (sectors * 512 bytes/sector * 1000ms) / 100ms
  const readBytesPerSec = (readDelta * 512 * 1000) / 100;
  const writeBytesPerSec = (writeDelta * 512 * 1000) / 100;

  // Convert to MB/s and round to 2 decimals
  const readMBps = Math.round((readBytesPerSec / (1024 * 1024)) * 100) / 100;
  const writeMBps = Math.round((writeBytesPerSec / (1024 * 1024)) * 100) / 100;

  return { readMBps, writeMBps };
}

function startHistoryCollection(): void {
  loadStatsHistory();
  // Collect immediately on startup
  collectStatsPoint();
  // Then collect every 5 minutes
  historyInterval = setInterval(collectStatsPoint, HISTORY_INTERVAL_MS);
}

function stopHistoryCollection(): void {
  if (historyInterval) {
    clearInterval(historyInterval);
    historyInterval = null;
  }
}

interface ProcessInfo {
  pid: number;
  name: string;
  cpu: number;
  memory: number;
  memoryBytes: number;
  ports: number[];
}

function getListeningPorts(): Map<number, number[]> {
  const pidToPorts = new Map<number, number[]>();
  try {
    // Get listening TCP ports with their PIDs using ss
    const output = execSync(
      'ss -tlnp 2>/dev/null | tail -n +2',
      { encoding: 'utf-8', timeout: 5000 }
    );

    for (const line of output.trim().split('\n')) {
      if (!line) continue;
      // Parse local address for port (e.g., "0.0.0.0:3020" or "*:3020" or "[::]:3020")
      const parts = line.trim().split(/\s+/);
      if (parts.length < 5) continue;

      const localAddr = parts[3];
      const portMatch = localAddr.match(/:(\d+)$/);
      if (!portMatch) continue;
      const port = parseInt(portMatch[1], 10);

      // Extract PID from the last column (e.g., 'users:(("node",pid=12345,fd=20))')
      const pidMatch = line.match(/pid=(\d+)/);
      if (!pidMatch) continue;
      const pid = parseInt(pidMatch[1], 10);

      if (!pidToPorts.has(pid)) {
        pidToPorts.set(pid, []);
      }
      const ports = pidToPorts.get(pid)!;
      if (!ports.includes(port)) {
        ports.push(port);
      }
    }
  } catch {
    // Ignore errors
  }
  return pidToPorts;
}

function getTopProcesses(): ProcessInfo[] {
  try {
    // Get listening ports first
    const pidToPorts = getListeningPorts();

    // Get top processes by CPU and memory using ps
    const output = execSync(
      'ps aux --no-headers --sort=-%cpu | head -20',
      { encoding: 'utf-8', timeout: 5000 }
    );

    const processes: ProcessInfo[] = [];
    const lines = output.trim().split('\n');

    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 11) continue;

      const pid = parseInt(parts[1], 10);
      const cpu = parseFloat(parts[2]);
      const memory = parseFloat(parts[3]);
      const rss = parseInt(parts[5], 10) * 1024; // RSS is in KB, convert to bytes
      // Command is everything from index 10 onwards
      let name = parts.slice(10).join(' ');

      // Clean up the process name - get just the executable name
      if (name.startsWith('[') && name.endsWith(']')) {
        // Kernel thread, keep as is
      } else {
        // Extract just the command name without path and args
        const cmdParts = name.split('/');
        name = cmdParts[cmdParts.length - 1].split(' ')[0];
        // Truncate long names
        if (name.length > 30) {
          name = name.substring(0, 27) + '...';
        }
      }

      if (pid && !isNaN(cpu) && !isNaN(memory)) {
        processes.push({
          pid,
          name,
          cpu,
          memory,
          memoryBytes: rss,
          ports: pidToPorts.get(pid) || []
        });
      }
    }

    // Sort by combined CPU + memory impact, take top 10
    return processes
      .sort((a, b) => (b.cpu + b.memory) - (a.cpu + a.memory))
      .slice(0, 10);
  } catch {
    return [];
  }
}

// Absolute path to rebuild script
const REBUILD_SCRIPT = '/home/conor/terminal-v4/rebuild.sh';
const PROJECT_ROOT = '/home/conor/terminal-v4';

export async function registerSystemRoutes(app: FastifyInstance): Promise<void> {
  // Start collecting stats history
  startHistoryCollection();

  // Clean up on server shutdown
  app.addHook('onClose', async () => {
    stopHistoryCollection();
  });

  app.get('/api/system/preview-config', async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    return reply.send({
      subdomainBase: PREVIEW_SUBDOMAIN_BASE,
      subdomainBases: PREVIEW_SUBDOMAIN_BASES,
      proxyHosts: PREVIEW_PROXY_HOSTS,
      preferPathBased: PREVIEW_DEFAULT_MODE === 'path-first',
      defaultMode: PREVIEW_DEFAULT_MODE,
      cookiePolicy: PREVIEW_COOKIE_POLICY,
      rewriteScope: PREVIEW_REWRITE_SCOPE
    });
  });

  // Get stats history for charts
  app.get('/api/system/stats/history', async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    // Parse query params for time range
    const { range } = request.query as { range?: string };
    let cutoff = Date.now() - 24 * 60 * 60 * 1000; // Default: last 24 hours

    if (range === '1h') cutoff = Date.now() - 60 * 60 * 1000;
    else if (range === '6h') cutoff = Date.now() - 6 * 60 * 60 * 1000;
    else if (range === '24h') cutoff = Date.now() - 24 * 60 * 60 * 1000;
    else if (range === '7d') cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    else if (range === '30d') cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;

    const filteredHistory = statsHistory.filter(p => p.timestamp > cutoff);

    return {
      history: filteredHistory,
      range: range || '24h',
      count: filteredHistory.length
    };
  });

  // Trigger app rebuild
  app.post('/api/system/rebuild', async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }

    return new Promise((resolve) => {
      const child = spawn('bash', [REBUILD_SCRIPT], {
        cwd: PROJECT_ROOT,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      child.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      child.on('close', (code) => {
        if (code === 0) {
          resolve({ success: true, message: 'Rebuild completed', output: stdout });
        } else {
          reply.code(500);
          resolve({ success: false, error: 'Rebuild failed', output: stderr || stdout });
        }
      });

      child.on('error', (err) => {
        reply.code(500);
        resolve({ success: false, error: err.message });
      });

      // Timeout after 5 minutes
      setTimeout(() => {
        child.kill();
        reply.code(500);
        resolve({ success: false, error: 'Rebuild timed out' });
      }, 5 * 60 * 1000);
    });
  });

  // Get system stats (RAM and CPU)
  app.get('/api/system/stats', async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    // Memory stats
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;

    // CPU stats - sample twice with 100ms delay for instantaneous usage
    const getCpuTimes = () => {
      return os.cpus().map(cpu => ({
        idle: cpu.times.idle,
        total: Object.values(cpu.times).reduce((a, b) => a + b, 0)
      }));
    };

    const startTimes = getCpuTimes();
    await new Promise(resolve => setTimeout(resolve, 100));
    const endTimes = getCpuTimes();

    const cpuUsage = startTimes.reduce((acc, start, i) => {
      const end = endTimes[i];
      const idleDiff = end.idle - start.idle;
      const totalDiff = end.total - start.total;
      return acc + (totalDiff > 0 ? ((totalDiff - idleDiff) / totalDiff) * 100 : 0);
    }, 0) / startTimes.length;

    // Disk I/O stats (separate 100ms sample)
    const diskIO = await calculateDiskIO();
    const eventLoopMeanMs = Math.round(eventLoopDelay.mean / 1e6);
    const eventLoopMaxMs = Math.round(eventLoopDelay.max / 1e6);
    eventLoopDelay.reset();

    return {
      memory: {
        total: totalMem,
        used: usedMem,
        free: freeMem,
        percentage: Math.round((usedMem / totalMem) * 100)
      },
      cpu: {
        percentage: Math.round(cpuUsage),
        cores: os.cpus().length
      },
      disk: {
        readMBps: diskIO.readMBps,
        writeMBps: diskIO.writeMBps
      },
      eventLoop: {
        meanMs: eventLoopMeanMs,
        maxMs: eventLoopMaxMs
      },
      processes: getTopProcesses()
    };
  });
}
