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

interface ScanDirectoryOptions {
  includePlainDirectoriesAtRoot?: boolean;
}

function getDefaultScanDirectories(homeDir: string = os.homedir()): string[] {
  return [
    homeDir,
    path.join(homeDir, 'Documents'),
    path.join(homeDir, 'code'),
    path.join(homeDir, 'Code'),
    path.join(homeDir, 'projects'),
    path.join(homeDir, 'Projects'),
    path.join(homeDir, 'dev'),
    path.join(homeDir, 'Developer'),
    path.join(homeDir, 'workspace'),
    path.join(homeDir, 'repos'),
    path.join(homeDir, 'src'),
    path.join(homeDir, 'GitHub'),
    // OneDrive paths
    path.join(homeDir, 'OneDrive', 'Documents'),
    path.join(homeDir, 'OneDrive', 'Personal', 'Documents'),
    path.join(homeDir, 'OneDrive', 'Personal', 'Documents', 'coding projects'),
    // Windows common paths
    'C:\\Users',
    'C:\\code',
    'C:\\projects',
    'C:\\dev',
    'D:\\code',
    'D:\\projects',
    'D:\\dev',
  ];
}

// Custom user directories (will be populated from settings)
let customScanDirectories: string[] = [];

// Cache for scanned projects
let projectCache: ProjectCache | null = null;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const MAX_PROJECTS = 100;
const MAX_DEPTH = 4;
const PLAIN_PROJECT_ROOT_NAMES = new Set([
  'code',
  'Code',
  'projects',
  'Projects',
  'dev',
  'Developer',
  'workspace',
  'repos',
  'src',
  'GitHub',
  'coding projects',
]);

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

function isGitRepository(dirPath: string): boolean {
  return fs.existsSync(path.join(dirPath, '.git'));
}

function buildProject(dirPath: string, name?: string): Project {
  const project: Project = {
    path: dirPath,
    name: name || path.basename(dirPath),
    lastModified: getLastModified(dirPath),
  };

  if (isGitRepository(dirPath)) {
    project.branch = getGitBranch(dirPath);
  }

  return project;
}

function isPlainProjectRoot(dirPath: string): boolean {
  const normalizedPath = path.normalize(dirPath);
  const baseName = path.basename(normalizedPath);
  return PLAIN_PROJECT_ROOT_NAMES.has(baseName);
}

/**
 * Recursively scan a directory for git repos
 */
async function scanDirectory(
  dirPath: string,
  depth: number,
  foundProjects: Project[],
  options: ScanDirectoryOptions = {}
): Promise<void> {
  const { includePlainDirectoriesAtRoot = false } = options;
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
        foundProjects.push(buildProject(fullPath, entry.name));
        // Don't recurse into this directory (it's a repo)
      } else {
        if (includePlainDirectoriesAtRoot && depth === 0) {
          foundProjects.push(buildProject(fullPath, entry.name));
        }
        // Recurse into subdirectory
        await scanDirectory(fullPath, depth + 1, foundProjects, options);
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
 * Add a custom directory to scan
 */
export function addCustomScanDirectory(dirPath: string): boolean {
  const normalizedPath = path.normalize(dirPath);
  if (!customScanDirectories.includes(normalizedPath)) {
    customScanDirectories.push(normalizedPath);
    clearProjectCache(); // Clear cache so next scan includes new dir
    return true;
  }
  return false;
}

/**
 * Remove a custom directory from scan
 */
export function removeCustomScanDirectory(dirPath: string): boolean {
  const normalizedPath = path.normalize(dirPath);
  const index = customScanDirectories.indexOf(normalizedPath);
  if (index > -1) {
    customScanDirectories.splice(index, 1);
    clearProjectCache();
    return true;
  }
  return false;
}

/**
 * Get current custom scan directories
 */
export function getCustomScanDirectories(): string[] {
  return [...customScanDirectories];
}

/**
 * Set custom scan directories (replaces existing)
 */
export function setCustomScanDirectories(dirs: string[]): void {
  customScanDirectories = dirs.map(d => path.normalize(d));
  clearProjectCache();
}

/**
 * Scan all configured directories for git repos
 */
async function scanForGitRepos(): Promise<Project[]> {
  const foundProjects: Project[] = [];
  const scannedPaths = new Set<string>();

  const allDirectories = [
    ...customScanDirectories.map((dirPath) => ({
      path: dirPath,
      includeRootAsProject: true,
      includePlainDirectoriesAtRoot: true,
    })),
    ...getDefaultScanDirectories().map((dirPath) => ({
      path: dirPath,
      includeRootAsProject: false,
      includePlainDirectoriesAtRoot: isPlainProjectRoot(dirPath),
    })),
  ];

  for (const scanTarget of allDirectories) {
    const scanDir = scanTarget.path;
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

    if (scanTarget.includeRootAsProject) {
      foundProjects.push(buildProject(realPath));
      if (foundProjects.length >= MAX_PROJECTS) {
        break;
      }
    }

    await scanDirectory(realPath, 0, foundProjects, {
      includePlainDirectoriesAtRoot: scanTarget.includePlainDirectoriesAtRoot,
    });

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
