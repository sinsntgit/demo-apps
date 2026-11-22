// The only thing prepared before recording: an AI model entry for the demo. (Everything else is created on screen.)
const { request } = require('playwright');
(async () => {
  const api = await request.newContext({ baseURL: process.argv[2] || 'http://localhost:8030', extraHTTPHeaders: { 'X-Requested-With': 'fetch' } });
  const r = await api.post('/api/auth/login', { data: { email: 'admin@example.com', password: 'Admin-Passw0rd!' } });
  if (r.status() !== 200) throw new Error('sign-in failed');
  const m = await api.post('/api/admin/models', { data: { name: 'Demo model', provider: 'openai_compatible', model_id: 'demo-1', api_key: 'demo-key',
    base_url: 'http://127.0.0.1:8765/v1', is_default: true, price_in: 3, price_out: 15 } });
  console.log('model', m.status());
  await api.put('/api/admin/settings', { data: { builds_per_hour: 200, tests_per_min: 60 } });
  process.exit(0);
})();
