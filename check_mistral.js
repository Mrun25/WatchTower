const https = require('https');
const MISTRAL_API_KEY = 'E9NDKsvKOV13vxiNDhHtmLe5XbJ9falB';

const data = JSON.stringify({
  model: 'mistral-large-latest',
  messages: [{ role: 'user', content: 'Say "API IS WORKING" and nothing else.' }],
  max_tokens: 50,
  temperature: 0.1
});

const req = https.request('https://api.mistral.ai/v1/chat/completions', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer ' + MISTRAL_API_KEY,
    'Content-Length': Buffer.byteLength(data)
  }
}, res => {
  let d = '';
  res.on('data', c => d += c);
  res.on('end', () => {
    console.log('Status Code:', res.statusCode);
    console.log('Response:', d);
  });
});

req.on('error', err => {
  console.error('Error connecting to Mistral:', err);
});

req.write(data);
req.end();
