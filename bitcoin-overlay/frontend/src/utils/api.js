const BASE_URL = '';

async function request(url, options = {}) {
  const response = await fetch(`${BASE_URL}${url}`, options);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Request failed: ${response.status}`);
  }
  return response.json();
}

export function fetchPrice() {
  return request('/api/price');
}

export function fetchChart(days = 30) {
  return request(`/api/chart?days=${days}`);
}

export function fetchAnalysis(days = 30) {
  return request('/api/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ days }),
  });
}

export function fetchSettings() {
  return request('/api/settings');
}

export function saveApiKey(apiKey) {
  return request('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey }),
  });
}

export function fetchPredictions() {
  return request('/api/predictions');
}
