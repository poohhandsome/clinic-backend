/* -------------------------------------------------- */
/* FILE: db.js (Database Connection)                  */
/* -------------------------------------------------- */

const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: process.env.NODE_ENV === 'production' ? true : false
  },

  // Neon-optimized settings for auto-suspend (saves compute hours)
  max: 10,                      // Maximum pool size (reduced from 20)
  min: 0,                       // CRITICAL: Allow pool to go to 0 connections (enables Neon auto-suspend)
  idleTimeoutMillis: 30000,     // Close idle connections after 30 seconds
  connectionTimeoutMillis: 10000, // Timeout after 10 seconds (increased from 2s for reliability)
});

// Handle pool errors to prevent application crashes
pool.on('error', (err, client) => {
  console.error('Unexpected error on idle PostgreSQL client:', err);
  // Don't exit process in production, just log the error
  if (process.env.NODE_ENV !== 'production') {
    process.exit(-1);
  }
});

// Graceful shutdown - close all connections on app termination
process.on('SIGTERM', () => {
  console.log('SIGTERM received, closing database pool...');
  pool.end(() => {
    console.log('Database pool closed');
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received, closing database pool...');
  pool.end(() => {
    console.log('Database pool closed');
    process.exit(0);
  });
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool: pool
};