/** Request logging, JSON parsing, CORS, optional API key, and error handling. */
import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import config from '../../config/default.js';
import logger from '../lib/logger.js';

const log = logger.child('http');

function requestLogger(req, res, next) {
  const start = Date.now();
  res.on('finish', () => {
    log.info(`${req.method} ${req.originalUrl} → ${res.statusCode} (${Date.now() - start}ms)`);
  });
  next();
}

const parseJson = express.json({ limit: config.server.bodyLimit });
function jsonParser(req, res, next) {
  parseJson(req, res, (err) => {
    if (err) return res.status(400).json({ success: false, error: `Invalid JSON: ${err.message}` });
    next();
  });
}

function cors(req, res, next) {
  res.header('Access-Control-Allow-Origin', config.server.corsOrigin);
  res.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Require API_KEY when configured. EventSource cannot send headers, so ?api_key= is accepted too. */
function apiKeyAuth(apiKey = config.server.apiKey) {
  return (req, res, next) => {
    if (!apiKey) return next();
    const provided = req.get('x-api-key') ?? req.query?.api_key;
    if (provided && safeEqual(provided, apiKey)) return next();
    res.status(401).json({ success: false, error: 'Missing or invalid API key (X-API-Key header)' });
  };
}

function errorHandler(err, req, res, _next) {
  log.error('Unhandled error:', err);
  const statusCode = err.statusCode || err.status || 500;
  const production = process.env.NODE_ENV === 'production';
  res.status(statusCode).json({
    success: false,
    error: production && statusCode >= 500 ? 'Internal server error' : err.message,
    ...(!production && statusCode >= 500 && { stack: err.stack }),
  });
}

function notFoundHandler(req, res) {
  res.status(404).json({ success: false, error: `Route not found: ${req.method} ${req.originalUrl}` });
}

export { requestLogger, jsonParser, cors, apiKeyAuth, errorHandler, notFoundHandler };
