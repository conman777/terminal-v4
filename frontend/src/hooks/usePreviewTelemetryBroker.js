import { useEffect } from 'react';
import { apiFetch } from '../utils/api';
import { captureAuthScope, isAuthScopeCurrent, subscribeAuth } from '../utils/auth';
import { getActiveEnvironment, subscribeEnvironment } from '../utils/remoteEnvironments';
import { getPreviewNavigationTarget } from '../utils/previewUrl';

export function usePreviewTelemetryBroker(iframeRef, authorizedUrl) {
  useEffect(() => {
    if (!authorizedUrl) return;
    const navigation = getPreviewNavigationTarget(authorizedUrl);
    if (!navigation) return;
    const authorized = new URL(navigation.url);
    const targetPath = new URL(navigation.targetPath, authorized.origin).pathname;
    const match = targetPath.match(/^(\/api\/environments\/[^/]+\/proxy)?\/preview\/(\d+)(?:\/|$)/);
    const port = match ? Number(match[2]) : null;
    const grant = authorized.searchParams.get('previewToken');
    if (!port || port > 65535 || !grant) return;
    const prefix = `${match[1] || ''}/preview/${port}`;
    const endpointPrefix = `${match[1] || ''}/api/preview/${port}`;
    const authScope = captureAuthScope();
    const environment = getActiveEnvironment();
    const controller = new AbortController();
    const current = () => !controller.signal.aborted && isAuthScopeCurrent(authScope)
      && captureAuthScope().userId === authScope.userId && getActiveEnvironment() === environment;
    const stopAuth = subscribeAuth(() => { if (!current()) controller.abort(); });
    const stopEnvironment = subscribeEnvironment(() => controller.abort());

    const onMessage = event => {
      if (!current() || !iframeRef.current || event.source !== iframeRef.current.contentWindow) return;
      const payload = event.data;
      if (!payload || payload.port !== port || typeof payload.documentUrl !== 'string') return;
      if (payload.type !== 'preview-performance' && payload.type !== 'preview-log-batch') return;
      try {
        const document = new URL(payload.documentUrl);
        const documentNavigation = getPreviewNavigationTarget(document.toString());
        if (!documentNavigation || document.origin !== authorized.origin || payload.documentGrant !== grant) return;
        const documentPath = new URL(documentNavigation.targetPath, document.origin).pathname;
        if (documentPath !== prefix && !documentPath.startsWith(`${prefix}/`)) return;
        let body;
        let endpoint;
        if (payload.type === 'preview-performance') {
          if (!Array.isArray(payload.metrics) || payload.metrics.length === 0 || payload.metrics.length > 500) return;
          if (!payload.metrics.every(metric => metric && ['coreWebVitals', 'loadMetrics', 'runtimeMetrics'].includes(metric.type)
            && Number.isSafeInteger(metric.timestamp) && metric.timestamp >= 0 && metric.data && typeof metric.data === 'object' && !Array.isArray(metric.data))) return;
          body = { metrics: payload.metrics.map(({ type, timestamp, data }) => ({ type, timestamp, data })) };
          endpoint = `${endpointPrefix}/performance`;
        } else {
          if (!Array.isArray(payload.entries) || payload.entries.length === 0 || payload.entries.length > 200) return;
          if (!payload.entries.every(entry => entry && typeof entry.id === 'string' && entry.id.length > 0 && entry.id.length <= 256
            && ['console', 'error'].includes(entry.type) && ['log', 'info', 'warn', 'error', 'debug'].includes(entry.level)
            && typeof entry.message === 'string' && entry.message.length <= 100000 && Number.isSafeInteger(entry.timestamp) && entry.timestamp >= 0)) return;
          body = payload.entries.map(({ id, type, level, message, timestamp }) => ({ id, type, level, message, timestamp }));
          endpoint = `${endpointPrefix}/logs`;
        }
        if (new TextEncoder().encode(JSON.stringify(body)).byteLength > 1000000) return;
        void apiFetch(endpoint, { home: true, method: 'POST', body, signal: controller.signal }).catch(() => {});
      } catch {
        // Invalid or nonserializable telemetry never receives owner request authority.
      }
    };
    window.addEventListener('message', onMessage);
    return () => { controller.abort(); stopAuth(); stopEnvironment(); window.removeEventListener('message', onMessage); };
  }, [iframeRef, authorizedUrl]);
}
