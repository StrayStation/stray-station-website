const https = require('https');

const SYSTEM_PROMPT = `You are a manufacturing process analyst. Extract structured data from the user's process description.
Return ONLY valid JSON with no markdown fences and no explanation.

Schema:
{
  "processName": "string",
  "demand": number,
  "shiftHours": number,
  "stations": [
    {
      "name": "string",
      "count": number,
      "batchSize": number,
      "cycleTimeHr": number,
      "ratePerHrPerUnit": number,
      "isBatch": boolean,
      "downtime": null
    }
  ],
  "bottleneckHint": "string or null",
  "constraints": ["string"]
}

downtime field: null OR {"minHr":number,"maxHr":number,"label":"string"} only if user explicitly mentions machine failures or downtime.
ratePerHrPerUnit = batchSize / cycleTimeHr for batch stations.
Continuous rate station (e.g. 20/hr): ratePerHrPerUnit=20, batchSize=1, cycleTimeHr=0.05, isBatch=false.
shiftHours: use stated value; if missing infer from demand/bottleneck rate; default 8.
demand = units per DAY. Keep station order exactly as described.`;

function postJson(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured in Netlify environment variables' }) };
  }

  let text;
  try {
    const payload = JSON.parse(event.body || '{}');
    text = payload.text || '';
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  if (!text) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing text field' }) };
  }

  const requestBody = JSON.stringify({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1200,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: text }],
  });

  const options = {
    hostname: 'api.anthropic.com',
    path: '/v1/messages',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(requestBody),
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
  };

  try {
    const resp = await postJson(options, requestBody);
    if (resp.status !== 200) {
      return { statusCode: 502, headers, body: JSON.stringify({ error: `Anthropic error ${resp.status}: ${resp.body.slice(0, 300)}` }) };
    }

    const apiData = JSON.parse(resp.body);
    let raw = apiData.content[0].text.trim();

    // Strip markdown fences if model adds them
    if (raw.startsWith('```')) {
      raw = raw.split('\n').slice(1).join('\n');
    }
    if (raw.endsWith('```')) {
      raw = raw.slice(0, -3).trim();
    }

    const parsed = JSON.parse(raw);
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, data: parsed }) };

  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: `Function error: ${e.message}` }) };
  }
};
