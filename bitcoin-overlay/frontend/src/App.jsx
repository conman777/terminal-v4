import React, { useState, useEffect, useCallback } from 'react';
import { useBitcoinData } from './hooks/useBitcoinData';
import { useAiAnalysis } from './hooks/useAiAnalysis';
import { fetchSettings } from './utils/api';
import PriceHeader from './components/PriceHeader';
import TimeRangeSelector from './components/TimeRangeSelector';
import PriceChart from './components/PriceChart';
import AnalysisPanel from './components/AnalysisPanel';

export default function App() {
  const { price, chartData, timeRange, setTimeRange, loading, error } = useBitcoinData();
  const { analysis, loading: analysisLoading, error: analysisError, refresh: refreshAnalysis } = useAiAnalysis(chartData, timeRange);
  const [activeAnnotation, setActiveAnnotation] = useState(null);
  const [hasApiKey, setHasApiKey] = useState(null);

  useEffect(() => {
    fetchSettings().then((s) => setHasApiKey(s.hasApiKey)).catch(() => setHasApiKey(false));
  }, []);

  const handleApiKeySaved = useCallback(() => {
    setHasApiKey(true);
    refreshAnalysis();
  }, [refreshAnalysis]);

  return (
    <div className="app">
      {error && (
        <div className="app-error">
          <span className="app-error__icon">!</span>
          <span>{error}</span>
        </div>
      )}
      <div className="main-content">
        <PriceHeader price={price} />
        <TimeRangeSelector range={timeRange} onChange={setTimeRange} />
        <PriceChart
          chartData={chartData}
          annotations={analysis?.annotations}
          onAnnotationClick={setActiveAnnotation}
          loading={loading}
          timeRange={timeRange}
        />
      </div>
      <AnalysisPanel
        analysis={analysis}
        loading={analysisLoading}
        error={analysisError}
        onRefresh={refreshAnalysis}
        activeAnnotation={activeAnnotation}
        hasApiKey={hasApiKey === true}
        onApiKeySaved={handleApiKeySaved}
      />
    </div>
  );
}
