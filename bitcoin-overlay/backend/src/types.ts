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
