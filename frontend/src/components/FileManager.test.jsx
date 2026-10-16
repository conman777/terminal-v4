import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('FileManager', () => {
  const componentSource = fs.readFileSync(path.resolve(process.cwd(), 'src/components/FileManager.jsx'), 'utf8');
  const stylesheet = fs.readFileSync(path.resolve(process.cwd(), 'src/ProFileManager.css'), 'utf8');

  it('loads the stylesheet for its pro-file-manager root class', () => {
    const rootClass = 'className="pro-file-manager"';

    expect(componentSource).toContain(rootClass);
    expect(componentSource).toMatch(/import\s+['"]\.\.\/ProFileManager\.css['"]/);
  });

  it('floats above the workspace instead of taking height from the terminal and preview', () => {
    expect(stylesheet).toMatch(/\.pro-file-manager\s*\{[^}]*position:\s*absolute;/);
  });
});
