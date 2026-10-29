import { webcrypto } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { bindStartImageTarget, captureStartImageBinding, captureStartImageSource, copyStartImages, startImageMessageRequestId, startImageRequestId } from './startImageTransfer';

const sourceScope = ['owner', 'https://home.test', 'home', 'workspace-start'];
const targetScope = ['owner', 'https://home.test', 'home', 'ss-one'];
const image = { localId: 'one', blob: new Blob(['image'], { type: 'image/png' }),
  name: 'chart.png', mimeType: 'image/png', bytes: 5, artifactId: 'a'.repeat(64), rawSha256: 'b'.repeat(64) };

function fakeStore(scope, initial = []) {
  let revision = 'r1';
  let rows = [...initial];
  const snapshot = () => ({ scopeKey: JSON.stringify(scope), authorityId: `${scope[3]}-authority`, storageState: 'ready',
    revision, text: 'Look at this', localIds: rows.map(row => row.localId), pending: null, removals: [] });
  return {
    getSnapshot: snapshot,
    hydrate: vi.fn(async () => snapshot()),
    getBlob: vi.fn(async id => {
      const row = rows.find(value => value.localId === id);
      if (!row) throw new Error('Missing source bytes');
      return row;
    }),
    addFiles: vi.fn(async (files, { expectedRevision }) => {
      if (revision !== expectedRevision) throw new Error('stale destination');
      rows = files.map((file, index) => ({ ...image, localId: `target-${index}`, blob: file, name: file.name }));
      revision = 'r2';
      return { committed: true, snapshot: snapshot() };
    }),
    replaceRows(value) { rows = value; revision = `${revision}x`; },
    setText(value) { const previous = this.getSnapshot; this.getSnapshot = () => ({ ...previous(), text: value }); },
  };
}

describe('start-image transfer', () => {
  it('derives one stable creation ID for an unchanged owner-scoped image draft', async () => {
    vi.stubGlobal('crypto', webcrypto);
    try {
      const source = await captureStartImageSource(fakeStore(sourceScope, [image]), () => true);
      const first = await startImageRequestId(source);
      expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(await startImageRequestId({ ...source })).toBe(first);
      const message = await startImageMessageRequestId(first);
      expect(message).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(message).not.toBe(first);
      expect(await startImageMessageRequestId(first)).toBe(message);
      expect(await startImageRequestId({ ...source, sourceRevision: 'another-revision' })).not.toBe(first);
      expect(await startImageRequestId({ ...source, sourceScope: ['other', ...sourceScope.slice(1)] })).not.toBe(first);
    } finally { vi.unstubAllGlobals(); }
  });
  it('records the image source before a destination session exists', async () => {
    const source = fakeStore(sourceScope, [image]);
    const saved = await captureStartImageSource(source, () => true);
    expect(saved).toEqual({ sourceScope, sourceAuthorityId: 'workspace-start-authority', sourceRevision: 'r1',
      sourceLocalIds: ['one'], text: 'Look at this' });
    expect(bindStartImageTarget(saved, targetScope)).toEqual({ ...saved, targetScope });
    expect(() => bindStartImageTarget(saved, ['another-owner', ...targetScope.slice(1)])).toThrow(/scope/i);
  });
  it('copies the saved bytes only into the bound empty session', async () => {
    const source = fakeStore(sourceScope, [image]), target = fakeStore(targetScope);
    const binding = await captureStartImageBinding(source, targetScope, () => true);
    const result = await copyStartImages({ source, target, binding, isCurrent: () => true });
    expect(result).toEqual({ copied: true, recovered: false, localIds: ['target-0'] });
    expect(target.addFiles).toHaveBeenCalledOnce();
    const file = target.addFiles.mock.calls[0][0][0];
    expect([file.name, file.type, file.size]).toEqual(['chart.png', 'image/png', 5]);
    expect(source.getSnapshot().localIds).toEqual(['one']);
  });

  it('recognizes an exact committed copy after interruption without adding it again', async () => {
    const source = fakeStore(sourceScope, [image]);
    const target = fakeStore(targetScope, [{ ...image, localId: 'already-copied' }]);
    const binding = await captureStartImageBinding(source, targetScope, () => true);
    expect(await copyStartImages({ source, target, binding, isCurrent: () => true }))
      .toEqual({ copied: true, recovered: true, localIds: ['already-copied'] });
    expect(target.addFiles).not.toHaveBeenCalled();
  });

  it('holds changed sources, foreign sessions, different destination images and changed text', async () => {
    const source = fakeStore(sourceScope, [image]), target = fakeStore(targetScope);
    const binding = await captureStartImageBinding(source, targetScope, () => true);
    source.replaceRows([{ ...image, localId: 'different' }]);
    await expect(copyStartImages({ source, target, binding, isCurrent: () => true })).rejects.toThrow(/changed/i);
    const clean = fakeStore(sourceScope, [image]);
    const cleanBinding = await captureStartImageBinding(clean, targetScope, () => true);
    await expect(copyStartImages({ source: clean, target: fakeStore(['foreign', ...targetScope.slice(1)]), binding: cleanBinding, isCurrent: () => true })).rejects.toThrow(/scope/i);
    const occupied = fakeStore(targetScope, [{ ...image, localId: 'other', rawSha256: 'c'.repeat(64) }]);
    await expect(copyStartImages({ source: clean, target: occupied, binding: cleanBinding, isCurrent: () => true })).rejects.toThrow(/review/i);
    const changedText = fakeStore(targetScope); changedText.setText('Newer text');
    await expect(copyStartImages({ source: clean, target: changedText, binding: cleanBinding, isCurrent: () => true })).rejects.toThrow(/changed/i);
    expect([target.addFiles.mock.calls, occupied.addFiles.mock.calls, changedText.addFiles.mock.calls]).toEqual([[], [], []]);
  });

  it('does not write after the account or environment changes', async () => {
    const source = fakeStore(sourceScope, [image]), target = fakeStore(targetScope);
    const binding = await captureStartImageBinding(source, targetScope, () => true);
    let current = true;
    source.getBlob.mockImplementation(async () => { current = false; return image; });
    await expect(copyStartImages({ source, target, binding, isCurrent: () => current })).rejects.toThrow(/scope/i);
    expect(target.addFiles).not.toHaveBeenCalled();
  });
});
