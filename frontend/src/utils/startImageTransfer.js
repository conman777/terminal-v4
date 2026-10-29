import { sha256Bytes } from './sha256';

// Copy only between already authenticated native image-draft stores. The caller
// must persist this binding before copying and must retain the source until the
// destination is confirmed. This operation never uploads or sends a message.
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const fail = text => { throw new Error(text); };

function guard(isCurrent) {
  if (typeof isCurrent !== 'function' || !isCurrent()) fail('The image transfer scope changed.');
}

function scopeOf(snapshot) {
  try {
    const scope = JSON.parse(snapshot.scopeKey);
    if (!Array.isArray(scope) || scope.length !== 4 || scope.some(value => typeof value !== 'string' || !value)) throw new Error();
    return scope;
  } catch { return fail('The image transfer scope is invalid.'); }
}

function ready(snapshot) {
  if (!snapshot || snapshot.storageState !== 'ready' || !snapshot.authorityId || !snapshot.revision
    || !Array.isArray(snapshot.localIds) || !Array.isArray(snapshot.removals)
    || snapshot.pending || snapshot.removals.length || snapshot.isHydrating || snapshot.isSaving) {
    fail('The saved image draft is not ready for transfer.');
  }
}

// An intact source revision identifies one start even in independently mounted
// tabs. The server rejects differing creation inputs against that same ID.
export async function startImageRequestId(source) {
  if (!Array.isArray(source?.sourceScope) || source.sourceScope.length !== 4 || source.sourceScope[2] !== 'home'
    || source.sourceScope[3] !== 'workspace-start' || source.sourceScope.some(value => typeof value !== 'string' || !value)
    || typeof source.sourceAuthorityId !== 'string' || !source.sourceAuthorityId || typeof source.sourceRevision !== 'string' || !source.sourceRevision
    || !Array.isArray(source.sourceLocalIds) || !source.sourceLocalIds.length || source.sourceLocalIds.length > 8
    || source.sourceLocalIds.some(value => typeof value !== 'string' || !value)) {
    fail('The saved image request identity could not be verified.');
  }
  const input = JSON.stringify(['v4-image-start-v1', source.sourceScope, source.sourceAuthorityId, source.sourceRevision, source.sourceLocalIds]);
  return deterministicUuid(input);
}

export async function startImageMessageRequestId(startRequestId) {
  if (typeof startRequestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(startRequestId)) fail('The saved start request identity is invalid.');
  return deterministicUuid(JSON.stringify(['v4-image-start-message-v1', startRequestId.toLowerCase()]));
}

async function deterministicUuid(input) {
  const digest = await sha256Bytes(new TextEncoder().encode(input));
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = [...digest.slice(0, 16)].map(value => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function captureStartImageSource(source, isCurrent) {
  guard(isCurrent);
  await source.hydrate();
  guard(isCurrent);
  const saved = source.getSnapshot(); ready(saved);
  const sourceScope = scopeOf(saved);
  if (sourceScope[2] !== 'home' || sourceScope[3] !== 'workspace-start') {
    fail('The image transfer scope is invalid.');
  }
  if (!saved.localIds.length || saved.localIds.length > 8 || new Set(saved.localIds).size !== saved.localIds.length) {
    fail('Choose one to eight saved images before continuing.');
  }
  return { sourceScope, sourceAuthorityId: saved.authorityId,
    sourceRevision: saved.revision, sourceLocalIds: [...saved.localIds], text: saved.text };
}

export function bindStartImageTarget(sourceBinding, targetScope) {
  const sourceScope = sourceBinding?.sourceScope;
  if (!Array.isArray(sourceScope) || sourceScope.length !== 4 || sourceScope[2] !== 'home' || sourceScope[3] !== 'workspace-start'
    || !Array.isArray(targetScope) || targetScope.length !== 4
    || !same(sourceScope.slice(0, 3), targetScope.slice(0, 3)) || !targetScope[3] || targetScope[3] === sourceScope[3]) {
    fail('The image transfer scope is invalid.');
  }
  return { ...sourceBinding, sourceScope: [...sourceScope], sourceLocalIds: [...sourceBinding.sourceLocalIds], targetScope: [...targetScope] };
}

export async function captureStartImageBinding(source, targetScope, isCurrent) {
  return bindStartImageTarget(await captureStartImageSource(source, isCurrent), targetScope);
}

function sourceMatches(saved, binding) {
  ready(saved);
  if (!same(scopeOf(saved), binding.sourceScope) || saved.authorityId !== binding.sourceAuthorityId
    || saved.revision !== binding.sourceRevision || saved.text !== binding.text || !same(saved.localIds, binding.sourceLocalIds)) {
    fail('The saved start image draft changed. Review it before continuing.');
  }
}

function targetMatches(saved, binding) {
  ready(saved);
  if (!same(scopeOf(saved), binding.targetScope)) fail('The destination image scope changed.');
  if (saved.text !== binding.text) fail('The destination draft changed. Review it before continuing.');
}

async function originals(store, ids, isCurrent) {
  const rows = [];
  for (const id of ids) {
    const row = await store.getBlob(id); guard(isCurrent);
    if (row.localId !== id || !(row.blob instanceof Blob) || row.blob.size !== row.bytes
      || row.blob.type !== row.mimeType || !row.name || !row.rawSha256 || !row.artifactId) {
      fail('The saved original image could not be verified.');
    }
    rows.push(row);
  }
  return rows;
}

function sameOriginals(left, right) {
  return left.length === right.length && left.every((row, index) =>
    ['name', 'mimeType', 'bytes', 'rawSha256', 'artifactId'].every(field => row[field] === right[index][field]));
}

export async function copyStartImages({ source, target, binding, isCurrent }) {
  guard(isCurrent);
  if (!binding || !Array.isArray(binding.sourceLocalIds) || !binding.sourceLocalIds.length
    || !Array.isArray(binding.sourceScope) || !Array.isArray(binding.targetScope)
    || !same(binding.sourceScope.slice(0, 3), binding.targetScope.slice(0, 3))
    || binding.sourceScope[2] !== 'home' || binding.sourceScope[3] !== 'workspace-start'
    || !binding.targetScope[3] || binding.targetScope[3] === binding.sourceScope[3]) {
    fail('The saved image transfer binding is invalid.');
  }
  await source.hydrate(); guard(isCurrent); sourceMatches(source.getSnapshot(), binding);
  const sourceRows = await originals(source, binding.sourceLocalIds, isCurrent);
  await source.hydrate(); guard(isCurrent); sourceMatches(source.getSnapshot(), binding);
  await target.hydrate(); guard(isCurrent);
  let saved = target.getSnapshot(); targetMatches(saved, binding);
  if (saved.localIds.length) {
    const destinationRows = await originals(target, saved.localIds, isCurrent);
    await target.hydrate(); guard(isCurrent);
    const latest = target.getSnapshot(); targetMatches(latest, binding);
    if (latest.revision !== saved.revision || !same(latest.localIds, saved.localIds)
      || !sameOriginals(sourceRows, destinationRows)) fail('The destination images need review before continuing.');
    return { copied: true, recovered: true, localIds: [...latest.localIds] };
  }
  const files = sourceRows.map(row => new File([row.blob], row.name, { type: row.mimeType }));
  const result = await target.addFiles(files, { expectedRevision: saved.revision });
  guard(isCurrent);
  if (result?.committed !== true) fail('The destination image copy could not be confirmed.');
  await source.hydrate(); guard(isCurrent); sourceMatches(source.getSnapshot(), binding);
  await target.hydrate(); guard(isCurrent);
  saved = target.getSnapshot(); targetMatches(saved, binding);
  const destinationRows = await originals(target, saved.localIds, isCurrent);
  await target.hydrate(); guard(isCurrent);
  const latest = target.getSnapshot(); targetMatches(latest, binding);
  if (latest.revision !== saved.revision || !same(latest.localIds, saved.localIds)
    || !sameOriginals(sourceRows, destinationRows)) fail('The destination images need review before continuing.');
  await source.hydrate(); guard(isCurrent); sourceMatches(source.getSnapshot(), binding);
  return { copied: true, recovered: false, localIds: [...latest.localIds] };
}
