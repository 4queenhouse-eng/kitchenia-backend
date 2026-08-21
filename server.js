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

// Rate limiting sur la route coûteuse (appels à l'API Anthropic) — protège
// contre les rafales rapides (bug en boucle, script automatisé), par IP.
// Complémentaire au quota journalier ci-dessous, qui lui est par APPAREIL
// (deviceId) et protège contre le contournement via désinstallation/réinstall.
const findRecipesLimiter = rateLimit({
  windowMs: 60 * 1000, // fenêtre de 1 minute
  max: 5, // max 5 requêtes par IP par minute
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de requêtes. Merci de patienter avant de réessayer.' },
});

// Longueur maximale acceptée pour un prompt (protège contre les abus/bugs)
const MAX_PROMPT_LENGTH = 2000;

// Timeout maximum pour l'appel à l'API Anthropic (évite un blocage indéfini)
const ANTHROPIC_TIMEOUT_MS = 60000;

// ─────────────────────────────────────────────────────────────────────────
// QUOTA JOURNALIER PAR APPAREIL
//
// Stocké en mémoire côté serveur (Map), PAS côté client (AsyncStorage) —
// contrairement à l'ancienne version, ce quota survit à une désinstallation/
// réinstallation de l'app puisqu'il est indexé par deviceId (identifiant
// natif de l'appareil, stable), et non par un état local que l'utilisateur
// peut effacer.
//
// Limite connue de cette approche (acceptable pour une V1 à petite échelle) :
// ce compteur est perdu si le serveur redémarre (redéploiement, crash) —
// pas une vraie base de données persistante. À faire évoluer si le trafic
// augmente significativement.
// ─────────────────────────────────────────────────────────────────────────
const DAILY_FREE_SEARCHES = 5;
const quotaStore = new Map(); // deviceId -> { date: 'YYYY-MM-DD', count: number }

function todayKey() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// Retourne { count, remaining } pour un deviceId donné, en réinitialisant
// automatiquement le compteur si la date stockée n'est plus celle d'aujourd'hui.
function getQuotaInfo(deviceId) {
  const entry = quotaStore.get(deviceId);
  const today = todayKey();
  if (!entry || entry.date !== today) {
    return { count: 0, remaining: DAILY_FREE_SEARCHES };
  }
  return { count: entry.count, remaining: Math.max(0, DAILY_FREE_SEARCHES - entry.count) };
}

function incrementQuota(deviceId) {
  const today = todayKey();
  const current = getQuotaInfo(deviceId);
  quotaStore.set(deviceId, { date: today, count: current.count + 1 });
}

// Route de santé — permet de vérifier que le serveur tourne (aussi utilisée
// par le ping externe qui empêche la mise en veille Render)
app.get('/', (req, res) => {
  res.json({ status: 'ok', app: 'KitchenIA Backend', version: '1.0.0' });
});

// Route de consultation du quota — ne consomme PAS de recherche, juste une
// lecture. Utilisée par l'app pour afficher "X recherches restantes".
app.get('/api/quota', (req, res) => {
  const { deviceId } = req.query;
  if (!deviceId || typeof deviceId !== 'string') {
    return res.status(400).json({ error: 'Le paramètre "deviceId" est requis.' });
  }
  const { remaining } = getQuotaInfo(deviceId);
  res.json({ remaining, limit: DAILY_FREE_SEARCHES });
});

// Route principale — reçoit le prompt de l'app et appelle l'API Anthropic
app.post('/api/find-recipes', findRecipesLimiter, async (req, res) => {
  const { prompt, deviceId } = req.body;
  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ error: 'Le champ "prompt" est requis.' });
  }
  if (prompt.length > MAX_PROMPT_LENGTH) {
    return res.status(400).json({
      error: `Le prompt est trop long (${MAX_PROMPT_LENGTH} caractères maximum).`,
    });
  }
  if (!deviceId || typeof deviceId !== 'string') {
    return res.status(400).json({ error: 'Le champ "deviceId" est requis.' });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'Clé API Anthropic non configurée sur le serveur.' });
  }

  // Vérification du quota journalier AVANT d'appeler Anthropic — évite de
  // dépenser un appel API pour une requête qui sera de toute façon refusée.
  const { remaining } = getQuotaInfo(deviceId);
  if (remaining <= 0) {
    return res.status(403).json({
      error: 'Quota de recherches gratuites épuisé pour aujourd\'hui.',
      code: 'QUOTA_EXCEEDED',
    });
  }

  // Contrôleur d'annulation pour appliquer un timeout à l'appel Anthropic
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ANTHROPIC_TIMEOUT_MS);

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
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

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

    // Quota décrémenté UNIQUEMENT après une réponse réussie d'Anthropic —
    // un échec (timeout, erreur API) ne doit pas coûter une recherche
    // gratuite à l'utilisateur.
    incrementQuota(deviceId);

    res.json(data);
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      console.error('Timeout Anthropic dépassé');
      return res.status(504).json({
        error: 'Le serveur met trop de temps à répondre. Merci de réessayer.',
      });
    }
    console.error('Erreur serveur:', err);
    res.status(500).json({ error: 'Erreur interne du serveur', detail: err.message });
  }
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ KitchenIA Backend démarré sur le port ${PORT}`);
});
