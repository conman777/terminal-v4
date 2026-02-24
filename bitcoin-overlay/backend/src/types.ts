export interface PriceData {
  price: number;
  change24h: number;
  marketCap: number;
  lastUpdated: string;
}

export interface ChartPoint {
  timestamp: number;
  date: string;
  price: number;
}

export interface VolumePoint {
  timestamp: number;
  date: string;
  volume: number;
}

export interface ChartData {
  prices: ChartPoint[];
  volumes: VolumePoint[];
}

export interface Annotation {
  timestamp: number;
  price: number;
  type: 'bullish' | 'bearish' | 'neutral';
  label: string;
  explanation: string;
}

export interface Prediction {
  timeframe: string;
  direction: 'up' | 'down' | 'sideways';
  confidence: number;
  reasoning: string;
}

export interface AiAnalysis {
  summary: string;
  annotations: Annotation[];
  currentAnalysis: string;
  predictions: Prediction[];
  keyFactors: string[];
}

export interface StoredPrediction {
  id: string;
  createdAt: number;
  expiresAt: number;
  priceAtPrediction: number;
  timeframe: '24h' | '1 week' | '1 month';
  direction: 'up' | 'down' | 'sideways';
  confidence: number;
  reasoning: string;
  status: 'pending' | 'correct' | 'incorrect';
  resolvedAt?: number;
  priceAtResolution?: number;
}

export interface PredictionStats {
  total: number;
  correct: number;
  incorrect: number;
  pending: number;
  accuracy: number;
  byTimeframe: Record<string, { total: number; correct: number; accuracy: number }>;
}
