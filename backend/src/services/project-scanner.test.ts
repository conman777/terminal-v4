import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearProjectCache, scanForProjects, setCustomScanDirectories } from './project-scanner';

describe('project-scanner', () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'project-scanner-'));
    clearProjectCache();
    setCustomScanDirectories([]);
  });

  afterEach(() => {
    clearProjectCache();
    setCustomScanDirectories([]);
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('includes plain top-level folders from an explicitly scanned project root', async () => {
    const projectsRoot = path.join(tempHome, 'OneDrive', 'Personal', 'Documents', 'coding projects');
    const upliftingPath = path.join(projectsRoot, 'uplifting');

    fs.mkdirSync(upliftingPath, { recursive: true });
    setCustomScanDirectories([projectsRoot]);

    const result = await scanForProjects(true);

    expect(result.projects.some((project) => project.path === fs.realpathSync(upliftingPath) && project.name === 'uplifting')).toBe(true);
  }, 15000);

  it('includes explicitly added folders even when they are not git repositories', async () => {
    const randomFolderPath = path.join(tempHome, 'random-folder');

    fs.mkdirSync(randomFolderPath, { recursive: true });
    setCustomScanDirectories([randomFolderPath]);

    const result = await scanForProjects(true);

    expect(result.projects.some((project) => project.path === fs.realpathSync(randomFolderPath) && project.name === 'random-folder')).toBe(true);
  }, 15000);

  it('finds repositories in default Documents scan roots', async () => {
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    const docsRepoPath = path.join(tempHome, 'Documents', 'docs-repo');
    const oneDriveRepoPath = path.join(tempHome, 'OneDrive', 'Personal', 'Documents', 'personal-docs-repo');

    fs.mkdirSync(path.join(docsRepoPath, '.git'), { recursive: true });
    fs.mkdirSync(path.join(oneDriveRepoPath, '.git'), { recursive: true });
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;

    try {
      const result = await scanForProjects(true);

      expect(result.projects.some((project) => project.path === fs.realpathSync(docsRepoPath) && project.name === 'docs-repo')).toBe(true);
      expect(result.projects.some((project) => project.path === fs.realpathSync(oneDriveRepoPath) && project.name === 'personal-docs-repo')).toBe(true);
    } finally {
      if (typeof originalHome === 'undefined') {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      if (typeof originalUserProfile === 'undefined') {
        delete process.env.USERPROFILE;
      } else {
        process.env.USERPROFILE = originalUserProfile;
      }
    }
  }, 15000);
});
