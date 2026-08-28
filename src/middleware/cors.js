'use strict';

const config = require('../../config');

/**
 * CORS configurable untuk mode terpisah (frontend di origin lain, mis. wa-bot-web).
 * Hanya mengizinkan origin yang tercantum di config.corsOrigins (env CORS_ORIGINS).
 * Origin tidak dikenal / list kosong → no-op (perilaku same-origin, backward-compatible).
 */
function corsMiddleware(req, res, next) {
  const origin = req.headers.origin;
  const allowed = config.corsOrigins;

  if (allowed.length > 0 && origin && allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      return res.sendStatus(204);
    }
  }
  next();
}

module.exports = { corsMiddleware };
