import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { Prediction, StoredPrediction, PredictionStats } from '../types';

const DATA_DIR = path.resolve(__dirname, '../../../data');
const DATA_FILE = path.join(DATA_DIR, 'predictions.json');

const TIMEFRAME_MS: Record<string, number> = {
  '24h': 86_400_000,
  '1 week': 604_800_000,
  '1 month': 2_592_000_000,
};

function ensureDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

export function loadPredictions(): StoredPrediction[] {
  try {
    if (!fs.existsSync(DATA_FILE)) return [];
    const raw = fs.readFileSync(DATA_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

export function savePredictions(predictions: StoredPrediction[]): void {
  ensureDir();
  fs.writeFileSync(DATA_FILE, JSON.stringify(predictions, null, 2));
}

export function addPredictions(predictions: Prediction[], currentPrice: number): StoredPrediction[] {
  const now = Date.now();
  const existing = loadPredictions();

  const newEntries: StoredPrediction[] = predictions
    .filter((p) => p.confidence > 0 && TIMEFRAME_MS[p.timeframe])
    .map((p) => ({
      id: crypto.randomUUID(),
      createdAt: now,
      expiresAt: now + TIMEFRAME_MS[p.timeframe],
      priceAtPrediction: currentPrice,
      timeframe: p.timeframe as StoredPrediction['timeframe'],
      direction: p.direction,
      confidence: p.confidence,
      reasoning: p.reasoning,
      status: 'pending' as const,
    }));

  const all = [...existing, ...newEntries];
  savePredictions(all);
  return newEntries;
}

export function resolvePredictions(currentPrice: number): void {
  const predictions = loadPredictions();
  const now = Date.now();
  let changed = false;

  for (const pred of predictions) {
    if (pred.status !== 'pending') continue;
    if (now < pred.expiresAt) continue;

    const priceDelta = (currentPrice - pred.priceAtPrediction) / pred.priceAtPrediction;
    let correct = false;

    if (pred.direction === 'up') {
      correct = priceDelta > 0.01;
    } else if (pred.direction === 'down') {
      correct = priceDelta < -0.01;
    } else {
      correct = Math.abs(priceDelta) <= 0.01;
    }

    pred.status = correct ? 'correct' : 'incorrect';
    pred.resolvedAt = now;
    pred.priceAtResolution = currentPrice;
    changed = true;
  }

  if (changed) {
    savePredictions(predictions);
  }
}

export function getStats(): PredictionStats {
  const predictions = loadPredictions();
  const total = predictions.length;
  const correct = predictions.filter((p) => p.status === 'correct').length;
  const incorrect = predictions.filter((p) => p.status === 'incorrect').length;
  const pending = predictions.filter((p) => p.status === 'pending').length;
  const resolved = correct + incorrect;
  const accuracy = resolved > 0 ? correct / resolved : 0;

  const byTimeframe: PredictionStats['byTimeframe'] = {};
  for (const pred of predictions) {
    if (!byTimeframe[pred.timeframe]) {
      byTimeframe[pred.timeframe] = { total: 0, correct: 0, accuracy: 0 };
    }
    byTimeframe[pred.timeframe].total++;
    if (pred.status === 'correct') {
      byTimeframe[pred.timeframe].correct++;
    }
  }
  for (const [key, tf] of Object.entries(byTimeframe)) {
    const tfPending = predictions.filter((p) => p.timeframe === key && p.status === 'pending').length;
    const tfResolved = tf.total - tfPending;
    tf.accuracy = tfResolved > 0 ? tf.correct / tfResolved : 0;
  }

  return { total, correct, incorrect, pending, accuracy, byTimeframe };
}

export function getResolvedForChart(): Pick<
  StoredPrediction,
  'createdAt' | 'expiresAt' | 'priceAtPrediction' | 'priceAtResolution' | 'direction' | 'status'
>[] {
  return loadPredictions()
    .filter((p) => p.status !== 'pending')
    .map(({ createdAt, expiresAt, priceAtPrediction, priceAtResolution, direction, status }) => ({
      createdAt,
      expiresAt,
      priceAtPrediction,
      priceAtResolution,
      direction,
      status,
    }));
}
