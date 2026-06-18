// netlify/functions/backend-data.js
//
// Fetches the full knowledgebase export from the SMRV backend API and returns it
// to the dashboard. Proxies the request server-side so the API key is never
// exposed to the browser.
//
// Required environment variables (set in Netlify → Site configuration → Environment variables):
//   BACKEND_API_URL         — e.g. https://your-backend.com
//   KNOWLEDGEBASE_API_KEY   — must match the value set in the backend .env

const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
let cache = { data: null, timestamp: 0 };

exports.handler = async function (event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers };
  }

  const apiUrl = process.env.BACKEND_API_URL;
  const apiKey = process.env.KNOWLEDGEBASE_API_KEY;

  if (!apiUrl || !apiKey) {
    return {
      statusCode: 503,
      headers,
      body: JSON.stringify({
        error: 'BACKEND_API_URL or KNOWLEDGEBASE_API_KEY environment variable is not set',
      }),
    };
  }

  // Serve from cache if still fresh
  const now = Date.now();
  if (cache.data && now - cache.timestamp < CACHE_TTL) {
    return { statusCode: 200, headers, body: JSON.stringify(cache.data) };
  }

  // Forward the includeAll query param if the dashboard passes it
  const includeAll = event.queryStringParameters?.includeAll === 'true';
  const url = `${apiUrl}/api/v1/knowledgebase/export${includeAll ? '?includeAll=true' : ''}`;

  try {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Backend API ${response.status}: ${text}`);
    }

    const data = await response.json();
    cache = { data, timestamp: now };

    return { statusCode: 200, headers, body: JSON.stringify(data) };
  } catch (err) {
    console.error('backend-data function error:', err);
    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
