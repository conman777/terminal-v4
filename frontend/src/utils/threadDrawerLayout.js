import { captureAuthScope } from './auth';
import { getEnvironmentCacheScope, getEnvironmentStorage } from './remoteEnvironments';

export const MIN_SPLIT_RATIO = 0.2;
export const MAX_SPLIT_RATIO = 0.8;
export const DEFAULT_DRAWER_HEIGHT = 260;
export const MIN_DRAWER_HEIGHT = 180;
const ID = /^[\w.:-]{1,128}$/;

export const defaultDrawerLayout = () => ({ splitId: null, direction: 'side-by-side', ratio: 0.5, height: DEFAULT_DRAWER_HEIGHT });

export function clampSplitRatio(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0.5;
  return Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, number));
}

export function clampDrawerHeight(value, maxHeight = Infinity) {
  const number = Number(value);
  const max = Math.max(MIN_DRAWER_HEIGHT, Number.isFinite(maxHeight) ? maxHeight : Infinity);
  if (!Number.isFinite(number)) return Math.min(DEFAULT_DRAWER_HEIGHT, max);
  return Math.round(Math.min(max, Math.max(MIN_DRAWER_HEIGHT, number)));
}

export function normalizeDrawerLayout(value) {
  const base = defaultDrawerLayout();
  if (!value || typeof value !== 'object') return base;
  return {
    splitId: typeof value.splitId === 'string' && ID.test(value.splitId) ? value.splitId : null,
    direction: value.direction === 'stacked' ? 'stacked' : base.direction,
    ratio: clampSplitRatio(value.ratio ?? base.ratio),
    height: clampDrawerHeight(value.height ?? base.height),
  };
}

export function drawerLayoutKey(threadId) {
  if (!threadId) return null;
  try {
    const auth = captureAuthScope();
    const environment = getEnvironmentCacheScope();
    return `threadDrawerLayout:v1:${JSON.stringify([auth.userId || '', environment.identity, environment.environment, threadId])}`;
  } catch { return null; }
}

export function readDrawerLayout(key) {
  if (!key) return defaultDrawerLayout();
  try { return normalizeDrawerLayout(JSON.parse(getEnvironmentStorage().getItem(key))); }
  catch { return defaultDrawerLayout(); }
}

export function writeDrawerLayout(key, layout) {
  if (!key) return false;
  try { getEnvironmentStorage().setItem(key, JSON.stringify(normalizeDrawerLayout(layout))); return true; }
  catch { return false; }
}

export function resolveSplitPartner(layout, terminalIds, primaryId) {
  const { splitId } = layout || {};
  return splitId && splitId !== primaryId && terminalIds.includes(splitId) ? splitId : null;
}
