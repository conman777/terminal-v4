import { PriceData, ChartData, ChartPoint, VolumePoint } from '../types.js';

const COINGECKO_BASE = 'https://api.coingecko.com/api/v3';

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry<unknown>>();

function getCached<T>(key: string): T | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.data as T;
}

function setCache<T>(key: string, data: T, ttlMs: number): void {
  cache.set(key, { data, expiresAt: Date.now() + ttlMs });
}

export async function getCurrentPrice(): Promise<PriceData> {
  const cacheKey = 'current-price';
  const cached = getCached<PriceData>(cacheKey);
  if (cached) return cached;

  const url = `${COINGECKO_BASE}/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true&include_market_cap=true`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`CoinGecko API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  const bitcoin = data.bitcoin;

  const priceData: PriceData = {
    price: bitcoin.usd,
    change24h: bitcoin.usd_24h_change,
    marketCap: bitcoin.usd_market_cap,
    lastUpdated: new Date().toISOString(),
  };

  setCache(cacheKey, priceData, 60_000);
  return priceData;
}

export async function getChartData(days: number): Promise<ChartData> {
  const cacheKey = `chart-${days}`;
  const cached = getCached<ChartData>(cacheKey);
  if (cached) return cached;

  const url = `${COINGECKO_BASE}/coins/bitcoin/market_chart?vs_currency=usd&days=${days}`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`CoinGecko API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();

  const prices: ChartPoint[] = (data.prices as [number, number][]).map(([timestamp, price]) => ({
    timestamp,
    date: new Date(timestamp).toISOString(),
    price,
  }));

  const volumes: VolumePoint[] = (data.total_volumes as [number, number][]).map(([timestamp, volume]) => ({
    timestamp,
    date: new Date(timestamp).toISOString(),
    volume,
  }));

  const chartData: ChartData = { prices, volumes };

  const ttlMs = days <= 1 ? 2 * 60_000 : 5 * 60_000;
  setCache(cacheKey, chartData, ttlMs);

  return chartData;
}
