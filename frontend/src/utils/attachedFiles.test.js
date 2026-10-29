import { describe, expect, it } from 'vitest';
import { withAttachedFiles } from './attachedFiles';

describe('withAttachedFiles', () => {
  it('lists attached files after the message so the agent can open them', () => {
    expect([
      withAttachedFiles('Review these', ['/work/a.pdf', '/work/b.png']),
      withAttachedFiles('', ['/work/a.pdf']),
      withAttachedFiles('Just text', []),
    ]).toEqual([
      'Review these\n\nAttached files:\n- /work/a.pdf\n- /work/b.png',
      'Attached files:\n- /work/a.pdf',
      'Just text',
    ]);
  });
});
