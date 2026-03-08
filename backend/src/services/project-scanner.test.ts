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
  });

  it('includes explicitly added folders even when they are not git repositories', async () => {
    const randomFolderPath = path.join(tempHome, 'random-folder');

    fs.mkdirSync(randomFolderPath, { recursive: true });
    setCustomScanDirectories([randomFolderPath]);

    const result = await scanForProjects(true);

    expect(result.projects.some((project) => project.path === fs.realpathSync(randomFolderPath) && project.name === 'random-folder')).toBe(true);
  });
});
