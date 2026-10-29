import { useEffect, useMemo, useState } from 'react';
import { apiFetch } from '../utils/api';
import { filterReadyAiOptions } from '../utils/aiProviders';

export function useReadyAiOptions(aiOptions, selectedId) {
  const [catalogAgents, setCatalogAgents] = useState(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/agent/catalog')
      .then(response => (response.ok ? response.json() : null))
      .then(catalog => { if (!cancelled && Array.isArray(catalog?.agents)) setCatalogAgents(catalog.agents); })
      .catch(() => { /* Without a catalog the full menu stays available. */ });
    return () => { cancelled = true; };
  }, []);

  return useMemo(() => filterReadyAiOptions(aiOptions, catalogAgents, selectedId), [aiOptions, catalogAgents, selectedId]);
}
