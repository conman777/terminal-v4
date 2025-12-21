import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';

export interface Project {
  path: string;
  name: string;
  branch?: string;
  lastModified?: number;
}

interface ProjectCache {
  projects: Project[];
  scannedAt: number;
  ttl: number;
}

interface ScanResponse {
  projects: Project[];
  scannedAt: number;
  fromCache: boolean;
}

// Directories to scan for git repos
const SCAN_DIRECTORIES = [
  os.homedir(),
  path.join(os.homedir(), 'Documents'),
  path.join(os.homedir(), 'code'),
  path.join(os.homedir(), 'Code'),
  path.join(os.homedir(), 'projects'),
  path.join(os.homedir(), 'Projects'),
  path.join(os.homedir(), 'dev'),
  path.join(os.homedir(), 'Developer'),
  path.join(os.homedir(), 'workspace'),
  path.join(os.homedir(), 'repos'),
  path.join(os.homedir(), 'src'),
];

// Cache for scanned projects
let projectCache: ProjectCache | null = null;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const MAX_PROJECTS = 50;
const MAX_DEPTH = 3;

// Directories to skip when scanning
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'vendor',
  'venv',
  '.venv',
  '__pycache__',
  'dist',
  'build',
  '.next',
  '.nuxt',
  'target',
  'out',
  '.cache',
  'coverage',
]);

/**
 * Get the current git branch for a repository
 */
function getGitBranch(repoPath: string): string | undefined {
  try {
    const result = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: repoPath,
      encoding: 'utf-8',
      timeout: 2000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return result.trim();
  } catch {
    return undefined;
  }
}

/**
 * Get the last modified time for a directory
 */
function getLastModified(dirPath: string): number | undefined {
  try {
    const stats = fs.statSync(dirPath);
    return stats.mtimeMs;
  } catch {
    return undefined;
  }
}

/**
 * Recursively scan a directory for git repos
 */
async function scanDirectory(
  dirPath: string,
  depth: number,
  foundProjects: Project[]
): Promise<void> {
  if (depth > MAX_DEPTH || foundProjects.length >= MAX_PROJECTS) {
    return;
  }

  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.') && entry.name !== '.git') continue;
      if (SKIP_DIRS.has(entry.name)) continue;

      const fullPath = path.join(dirPath, entry.name);

      // Check if this is a git repo
      if (entry.name === '.git') {
        // Parent is a git repo
        const repoPath = dirPath;
        const project: Project = {
          path: repoPath,
          name: path.basename(repoPath),
          branch: getGitBranch(repoPath),
          lastModified: getLastModified(repoPath),
        };
        foundProjects.push(project);
        return; // Don't recurse into .git or subdirectories of a repo
      }

      // Check if subdirectory contains .git
      const gitPath = path.join(fullPath, '.git');
      if (fs.existsSync(gitPath)) {
        const project: Project = {
          path: fullPath,
          name: entry.name,
          branch: getGitBranch(fullPath),
          lastModified: getLastModified(fullPath),
        };
        foundProjects.push(project);
        // Don't recurse into this directory (it's a repo)
      } else {
        // Recurse into subdirectory
        await scanDirectory(fullPath, depth + 1, foundProjects);
      }

      if (foundProjects.length >= MAX_PROJECTS) {
        return;
      }
    }
  } catch (error) {
    // Permission denied or other error, skip this directory
  }
}

/**
 * Scan all configured directories for git repos
 */
async function scanForGitRepos(): Promise<Project[]> {
  const foundProjects: Project[] = [];
  const scannedPaths = new Set<string>();

  for (const scanDir of SCAN_DIRECTORIES) {
    if (!fs.existsSync(scanDir)) continue;

    // Resolve to real path to handle symlinks
    let realPath: string;
    try {
      realPath = fs.realpathSync(scanDir);
    } catch {
      continue;
    }

    // Skip if we've already scanned this path
    if (scannedPaths.has(realPath)) continue;
    scannedPaths.add(realPath);

    await scanDirectory(realPath, 0, foundProjects);

    if (foundProjects.length >= MAX_PROJECTS) {
      break;
    }
  }

  // Remove duplicates (same repo found via different paths)
  const uniqueProjects = new Map<string, Project>();
  for (const project of foundProjects) {
    try {
      const realPath = fs.realpathSync(project.path);
      if (!uniqueProjects.has(realPath)) {
        uniqueProjects.set(realPath, { ...project, path: realPath });
      }
    } catch {
      // If we can't resolve the path, skip it
    }
  }

  // Sort by last modified (most recent first)
  const sortedProjects = Array.from(uniqueProjects.values()).sort((a, b) => {
    const aTime = a.lastModified || 0;
    const bTime = b.lastModified || 0;
    return bTime - aTime;
  });

  return sortedProjects.slice(0, MAX_PROJECTS);
}

/**
 * Get projects, using cache if available and not expired
 */
export async function scanForProjects(force: boolean = false): Promise<ScanResponse> {
  const now = Date.now();

  // Return cached results if available and not expired
  if (!force && projectCache && now - projectCache.scannedAt < projectCache.ttl) {
    return {
      projects: projectCache.projects,
      scannedAt: projectCache.scannedAt,
      fromCache: true,
    };
  }

  // Scan for projects
  const projects = await scanForGitRepos();

  // Update cache
  projectCache = {
    projects,
    scannedAt: now,
    ttl: CACHE_TTL,
  };

  return {
    projects,
    scannedAt: now,
    fromCache: false,
  };
}

/**
 * Clear the project cache
 */
export function clearProjectCache(): void {
  projectCache = null;
}
