const express = require('express');
const fetch   = require('node-fetch');
const app     = express();

app.use(express.json());
app.use(express.static(__dirname));

const ALPHA_BIAS_URL = process.env.ALPHA_BIAS_URL || 'http://localhost:3000';

// Proxy alle /api/* Calls an den Alpha-Bias Server
// Das Dashboard schickt den JWT Token im Header mit
app.use('/proxy', async (req, res) => {
  try {
    const target = ALPHA_BIAS_URL + req.url;
    const r = await fetch(target, {
      method:  req.method,
      headers: {
        'Authorization': req.headers['authorization'] || '',
        'Content-Type':  'application/json',
      },
      body: ['POST','PUT','PATCH'].includes(req.method) ? JSON.stringify(req.body) : undefined,
    });
    const data = await r.json();
    res.status(r.status).json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

// Alle anderen Routen → Dashboard
app.get('*', (req, res) => res.sendFile(__dirname + '/es_algo_dashboard.html'));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Dashboard running on port ${PORT}`));
