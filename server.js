// backend/server.js
// Proxy sécurisé entre l'app KitchenIA et l'API Anthropic.
// Déployer sur Render.com (gratuit) — voir README pour les instructions.

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/v1/messages';

// Route de santé — permet de vérifier que le serveur tourne
app.get('/', (req, res) => {
  res.json({ status: 'ok', app: 'KitchenIA Backend', version: '1.0.0' });
});

// Route principale — reçoit le prompt de l'app et appelle l'API Anthropic
app.post('/api/find-recipes', async (req, res) => {
  const { prompt } = req.body;

  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ error: 'Le champ "prompt" est requis.' });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'Clé API Anthropic non configurée sur le serveur.' });
  }

  try {
    const response = await fetch(ANTHROPIC_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }],
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('Erreur Anthropic:', errText);
      return res.status(response.status).json({ error: 'Erreur API Anthropic', detail: errText });
    }

    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('Erreur serveur:', err);
    res.status(500).json({ error: 'Erreur interne du serveur', detail: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ KitchenIA Backend démarré sur le port ${PORT}`);
});
