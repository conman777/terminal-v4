import { PriceData, ChartData, ChartPoint, AiAnalysis, Annotation } from '../types';

interface CacheEntry {
  data: AiAnalysis;
  expiresAt: number;
}

const analysisCache = new Map<string, CacheEntry>();

function getCachedAnalysis(key: string): AiAnalysis | null {
  const entry = analysisCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    analysisCache.delete(key);
    return null;
  }
  return entry.data;
}

function setCacheAnalysis(key: string, data: AiAnalysis, ttlMs: number): void {
  analysisCache.set(key, { data, expiresAt: Date.now() + ttlMs });
}

export function downsampleData(prices: ChartPoint[], targetPoints: number): ChartPoint[] {
  if (prices.length <= targetPoints) return prices;

  let minIdx = 0;
  let maxIdx = 0;
  for (let i = 1; i < prices.length; i++) {
    if (prices[i].price < prices[minIdx].price) minIdx = i;
    if (prices[i].price > prices[maxIdx].price) maxIdx = i;
  }

  const step = (prices.length - 1) / (targetPoints - 1);
  const selectedIndices = new Set<number>();

  selectedIndices.add(minIdx);
  selectedIndices.add(maxIdx);

  for (let i = 0; i < targetPoints; i++) {
    const idx = Math.round(i * step);
    selectedIndices.add(idx);
  }

  const sortedIndices = Array.from(selectedIndices).sort((a, b) => a - b);
  return sortedIndices.map((i) => prices[i]);
}

function formatCurrency(value: number): string {
  if (value >= 1_000_000_000_000) return `$${(value / 1_000_000_000_000).toFixed(2)}T`;
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function buildPrompt(
  priceData: PriceData,
  chartData: ChartData,
  days: number
): { systemPrompt: string; userPrompt: string } {
  const downsampled = downsampleData(chartData.prices, 80);

  const pricePoints = downsampled.map((p) => [p.timestamp, Math.round(p.price * 100) / 100]);

  const systemPrompt = `You are a senior cryptocurrency analyst. Analyze Bitcoin price data and provide structured analysis. Respond ONLY with valid JSON matching this exact schema: { "summary": "string (2-3 sentences)", "annotations": [{ "timestamp": number, "price": number, "type": "bullish"|"bearish"|"neutral", "label": "string (max 5 words)", "explanation": "string" }] (3-7 significant points), "currentAnalysis": "string (detailed paragraph)", "predictions": [{ "timeframe": "string", "direction": "up"|"down"|"sideways", "confidence": number (0-100), "reasoning": "string" }] (exactly 3: 24h, 1 week, 1 month), "keyFactors": ["string"] (3-5 driving factors) }`;

  const userPrompt = `Current BTC Price: ${formatCurrency(priceData.price)}, 24h Change: ${priceData.change24h.toFixed(2)}%, Market Cap: ${formatCurrency(priceData.marketCap)}. Price data (${days} days, ${downsampled.length} points): ${JSON.stringify(pricePoints)}. Analyze the price action, identify significant events, and provide predictions.`;

  return { systemPrompt, userPrompt };
}

function snapAnnotationsToData(annotations: Annotation[], prices: ChartPoint[]): Annotation[] {
  if (prices.length === 0) return annotations;

  return annotations.map((annotation) => {
    let closestIdx = 0;
    let closestDist = Math.abs(prices[0].timestamp - annotation.timestamp);

    for (let i = 1; i < prices.length; i++) {
      const dist = Math.abs(prices[i].timestamp - annotation.timestamp);
      if (dist < closestDist) {
        closestDist = dist;
        closestIdx = i;
      }
    }

    return {
      ...annotation,
      timestamp: prices[closestIdx].timestamp,
      price: prices[closestIdx].price,
    };
  });
}

function createFallbackAnalysis(): AiAnalysis {
  return {
    summary: 'Analysis temporarily unavailable. Please try again in a few moments.',
    annotations: [],
    currentAnalysis: 'Unable to generate analysis at this time. The AI service may be temporarily unavailable.',
    predictions: [
      { timeframe: '24h', direction: 'sideways', confidence: 0, reasoning: 'Analysis unavailable' },
      { timeframe: '1 week', direction: 'sideways', confidence: 0, reasoning: 'Analysis unavailable' },
      { timeframe: '1 month', direction: 'sideways', confidence: 0, reasoning: 'Analysis unavailable' },
    ],
    keyFactors: ['Analysis service temporarily unavailable'],
  };
}

function validateAnalysis(parsed: unknown): parsed is AiAnalysis {
  if (!parsed || typeof parsed !== 'object') return false;
  const obj = parsed as Record<string, unknown>;
  return (
    typeof obj.summary === 'string' &&
    Array.isArray(obj.annotations) &&
    typeof obj.currentAnalysis === 'string' &&
    Array.isArray(obj.predictions) &&
    Array.isArray(obj.keyFactors)
  );
}

export async function analyzeChart(
  priceData: PriceData,
  chartData: ChartData,
  days: number
): Promise<AiAnalysis> {
  const cacheKey = `analysis-${days}`;
  const cached = getCachedAnalysis(cacheKey);
  if (cached) return cached;

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey || apiKey === 'your_key_here') {
    console.warn('OPENROUTER_API_KEY not configured, returning fallback analysis');
    return createFallbackAnalysis();
  }

  const { systemPrompt, userPrompt } = buildPrompt(priceData, chartData, days);

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'google/gemini-2.5-flash',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.7,
        max_tokens: 4096,
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenRouter API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    let content = data.choices?.[0]?.message?.content;

    if (!content) {
      throw new Error('No content in OpenRouter response');
    }

    content = content.trim();
    if (content.startsWith('```json')) {
      content = content.slice(7);
    } else if (content.startsWith('```')) {
      content = content.slice(3);
    }
    if (content.endsWith('```')) {
      content = content.slice(0, -3);
    }
    content = content.trim();

    const parsed = JSON.parse(content);

    if (!validateAnalysis(parsed)) {
      throw new Error('AI response does not match expected schema');
    }

    const analysis: AiAnalysis = {
      summary: parsed.summary,
      annotations: snapAnnotationsToData(parsed.annotations, chartData.prices),
      currentAnalysis: parsed.currentAnalysis,
      predictions: parsed.predictions,
      keyFactors: parsed.keyFactors,
    };

    setCacheAnalysis(cacheKey, analysis, 10 * 60_000);
    return analysis;
  } catch (error) {
    console.error('AI analysis failed:', error);
    return createFallbackAnalysis();
  }
}
