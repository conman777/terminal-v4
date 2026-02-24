import React, { useState, useEffect, useCallback } from 'react';
import { useBitcoinData } from './hooks/useBitcoinData';
import { useAiAnalysis } from './hooks/useAiAnalysis';
import { usePredictions } from './hooks/usePredictions';
import { fetchSettings } from './utils/api';
import PriceHeader from './components/PriceHeader';
import TimeRangeSelector from './components/TimeRangeSelector';
import PriceChart from './components/PriceChart';
import AnalysisPanel from './components/AnalysisPanel';

export default function App() {
  const { price, chartData, timeRange, setTimeRange, loading, error } = useBitcoinData();
  const { analysis, loading: analysisLoading, error: analysisError, refresh: refreshAnalysis } = useAiAnalysis(chartData, timeRange);
  const [analysisRefreshKey, setAnalysisRefreshKey] = useState(0);
  const { predictions, stats } = usePredictions(analysisRefreshKey);
  const [activeAnnotation, setActiveAnnotation] = useState(null);
  const [hasApiKey, setHasApiKey] = useState(null);

  useEffect(() => {
    fetchSettings().then((s) => setHasApiKey(s.hasApiKey)).catch(() => setHasApiKey(false));
  }, []);

  const handleRefreshAnalysis = useCallback(() => {
    refreshAnalysis();
    setAnalysisRefreshKey((k) => k + 1);
  }, [refreshAnalysis]);

  const handleApiKeySaved = useCallback(() => {
    setHasApiKey(true);
    handleRefreshAnalysis();
  }, [handleRefreshAnalysis]);

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
          predictions={predictions}
        />
      </div>
      <AnalysisPanel
        analysis={analysis}
        loading={analysisLoading}
        error={analysisError}
        onRefresh={handleRefreshAnalysis}
        activeAnnotation={activeAnnotation}
        hasApiKey={hasApiKey === true}
        onApiKeySaved={handleApiKeySaved}
        stats={stats}
        predictions={predictions}
      />
    </div>
  );
}
