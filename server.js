// backend/server.js
// Proxy sécurisé entre l'app KitchenIA et l'API Anthropic.
// Déployer sur Render.com (gratuit) — voir README pour les instructions.
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const rateLimit = require('express-rate-limit');
const app = express();
app.use(cors());
app.use(express.json());
const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/v1/messages';

// Rate limiting sur la route coûteuse (appels à l'API Anthropic)
const findRecipesLimiter = rateLimit({
  windowMs: 60 * 1000, // fenêtre de 1 minute
  max: 5, // max 5 requêtes par IP par minute
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de requêtes. Merci de patienter avant de réessayer.' },
});

// Route de santé — permet de vérifier que le serveur tourne
app.get('/', (req, res) => {
  res.json({ status: 'ok', app: 'KitchenIA Backend', version: '1.0.0' });
});
// Route principale — reçoit le prompt de l'app et appelle l'API Anthropic
app.post('/api/find-recipes', findRecipesLimiter, async (req, res) => {
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
        // Augmenté de 2000 à 4096 : 2 recettes complètes (titre, ingrédients,
        // étapes, substitutions) + les blocs de résultats web_search consomment
        // plus de tokens que prévu, ce qui tronquait le JSON en sortie.
        max_tokens: 4096,
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
    // Avertissement utile dans les logs si la réponse a quand même été coupée
    // (utile pour diagnostiquer si 4096 s'avère encore insuffisant un jour)
    if (data.stop_reason === 'max_tokens') {
      console.warn('⚠️ Réponse Claude tronquée (max_tokens atteint) — envisager d\'augmenter max_tokens davantage.');
    }
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
