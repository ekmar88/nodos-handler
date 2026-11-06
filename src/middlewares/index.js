/**
 * Middleware
 * Request logging, error handling, and validation
 */

import express from 'express';
import config from '../../config/default.js';

/**
 * Request logger middleware
 * Logs incoming requests with method, URL, and timestamp
 */
function requestLogger(req, res, next) {
  const start = Date.now();
  const timestamp = new Date().toISOString();

  // Capture the original end method to log response
  const originalEnd = res.end;
  res.end = function (...args) {
    const duration = Date.now() - start;
    console.log(
      `[${timestamp}] ${req.method} ${req.originalUrl} ` +
      `→ ${res.statusCode} (${duration}ms)`
    );
    originalEnd.apply(res, args);
  };

  next();
}

/**
 * JSON body parser with size limit
 */
function jsonParser(req, res, next) {
  const limit = config.server.bodyLimit || '1mb';

  // Use express built-in JSON parser
  express.json({ limit })(req, res, (err) => {
    if (err) {
      return res.status(400).json({
        success: false,
        error: `Invalid JSON: ${err.message}`,
      });
    }
    next();
  });
}

/**
 * Global error handler
 * Catches unhandled errors and returns a consistent JSON response
 */
function errorHandler(err, req, res, _next) {
  console.error('[Error] Unhandled error:', err);

  const statusCode = err.statusCode || err.status || 500;

  res.status(statusCode).json({
    success: false,
    error: process.env.NODE_ENV === 'production'
      ? 'Internal server error'
      : err.message,
    ...(process.env.NODE_ENV !== 'production' && { stack: err.stack }),
  });
}

/**
 * 404 handler
 * Returns a JSON 404 for unknown routes
 */
function notFoundHandler(req, res) {
  res.status(404).json({
    success: false,
    error: `Route not found: ${req.method} ${req.originalUrl}`,
  });
}

export {
  requestLogger,
  jsonParser,
  errorHandler,
  notFoundHandler,
};
