#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function frontendAssets(indexHtml) {
  const found = new Set();
  for (const match of indexHtml.matchAll(/\b(?:src|href)\s*=\s*"([^"]*)"/g)) {
    const start = match[1].indexOf('assets/');
    if (start === -1) continue;
    const asset = match[1].slice(start).split(/[?#]/)[0];
    if (asset.length > 'assets/'.length) found.add(asset);
  }
  return [...found].sort();
}

export function manifestHash(assets) {
  return createHash('sha256').update(assets.join('\n')).digest('hex');
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function sameList(a, b) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export async function verifyDeployment({ baseUrl, expectCommit, distDir, allowDirty = false, fetchImpl = fetch }) {
  const failures = [];
  const base = new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  const get = async (pathname) => {
    try {
      const response = await fetchImpl(new URL(pathname, base), { redirect: 'manual' });
      return { response, bytes: Buffer.from(await response.arrayBuffer()) };
    } catch (error) {
      failures.push(`${pathname}: request failed (${error.message})`);
      return null;
    }
  };

  let info = null;
  const infoResult = await get('api/build-info');
  if (infoResult) {
    if (infoResult.response.status !== 200) {
      failures.push(`/api/build-info returned ${infoResult.response.status}; this server does not report build identity (old or wrong server)`);
    } else {
      try {
        info = JSON.parse(infoResult.bytes.toString('utf8'));
      } catch {
        failures.push('/api/build-info did not return JSON');
      }
    }
  }
  if (info) {
    if (typeof info.commit !== 'string' || !info.commit || info.commit === 'unknown') {
      failures.push(`build-info commit is "${info.commit ?? ''}"; backend was built without commit identity`);
    }
    if (typeof info.frontend?.manifestHash !== 'string' || !Array.isArray(info.frontend?.assets)) {
      failures.push('build-info has no frontend manifest');
      info = null;
    }
  }
  if (info) {
    if (expectCommit) {
      const actual = String(info.commit);
      if (!actual.startsWith(expectCommit) && !expectCommit.startsWith(actual)) {
        failures.push(`commit mismatch: server reports ${actual}, expected ${expectCommit}`);
      }
    }
    if (info.dirty && !allowDirty) {
      failures.push('server binary was built from a dirty working tree (pass --allow-dirty to accept)');
    }
    if (info.frontend.manifestHash !== manifestHash(info.frontend.assets)) {
      failures.push('build-info manifestHash does not match its own asset list');
    }
  }

  let servedAssets = [];
  const root = await get('');
  if (root) {
    const contentType = root.response.headers.get('content-type') ?? '';
    if (root.response.status !== 200 || !contentType.includes('text/html')) {
      failures.push(`/ returned ${root.response.status} ${contentType || 'no content-type'}, expected HTML 200`);
    } else {
      servedAssets = frontendAssets(root.bytes.toString('utf8'));
      if (servedAssets.length === 0) failures.push('/ references no hashed assets/; a generic 200 page is not proof');
    }
  }

  if (info && servedAssets.length > 0 && info.frontend.manifestHash !== manifestHash(servedAssets)) {
    failures.push(`served index.html assets (${servedAssets.join(', ')}) do not match build-info manifest (${info.frontend.assets.join(', ')})`);
  }

  let distAssets = null;
  if (distDir) {
    try {
      distAssets = frontendAssets(await readFile(path.join(distDir, 'index.html'), 'utf8'));
    } catch {
      failures.push(`cannot read ${path.join(distDir, 'index.html')}`);
    }
    if (distAssets && servedAssets.length > 0 && !sameList(distAssets, servedAssets)) {
      failures.push(`local dist assets (${distAssets.join(', ')}) differ from served assets (${servedAssets.join(', ')})`);
    }
  }

  for (const asset of servedAssets) {
    const fetched = await get(asset);
    if (!fetched) continue;
    const type = fetched.response.headers.get('content-type') ?? '';
    if (fetched.response.status !== 200 || type.includes('text/html')) {
      failures.push(`/${asset} returned ${fetched.response.status} ${type}; asset is not really served`);
      continue;
    }
    if (distDir && distAssets?.includes(asset)) {
      try {
        const local = await readFile(path.join(distDir, asset));
        if (sha256(local) !== sha256(fetched.bytes)) failures.push(`/${asset} bytes differ from local dist`);
      } catch {
        failures.push(`cannot read local dist/${asset}`);
      }
    }
  }

  return {
    ok: failures.length === 0,
    failures,
    commit: info?.commit ?? null,
    manifestHash: info?.frontend?.manifestHash ?? null,
    assets: servedAssets,
  };
}

function parseArguments(argv) {
  const options = { allowDirty: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--allow-dirty') options.allowDirty = true;
    else if (argument === '--url') options.baseUrl = argv[++index];
    else if (argument === '--expect-commit') options.expectCommit = argv[++index];
    else if (argument === '--dist') options.distDir = argv[++index];
    else throw new Error(`unknown argument ${argument}`);
  }
  if (!options.baseUrl) throw new Error('--url is required');
  return options;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    const result = await verifyDeployment(parseArguments(process.argv.slice(2)));
    if (result.ok) {
      console.log(`OK commit=${result.commit} manifest=${result.manifestHash} assets=${result.assets.join(',')}`);
    } else {
      for (const failure of result.failures) console.error(`FAIL: ${failure}`);
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(`usage: verify-deployment.mjs --url URL [--expect-commit HASH] [--dist frontend/dist] [--allow-dirty]\n${error.message}`);
    process.exitCode = 2;
  }
}
