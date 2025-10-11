/* -------------------------------------------------- */
/* FILE: db.js (Database Connection)                  */
/* -------------------------------------------------- */

const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,

  // CRITICAL FIX: Supabase SSL Configuration
  // Set to false to accept Supabase's certificate and avoid "self-signed certificate" error
  ssl: {
    rejectUnauthorized: false
  },

  // Optimized connection pool settings for Supabase
  max: 20,                        // Maximum pool size
  min: 0,                         // Allow pool to drain to 0 when idle
  idleTimeoutMillis: 30000,       // Close idle connections after 30 seconds
  connectionTimeoutMillis: 10000, // Connection timeout (10 seconds)
});

// Connection success handler
pool.on('connect', (client) => {
  console.log('✅ Connected to Supabase PostgreSQL');
});

// Handle pool errors to prevent application crashes
pool.on('error', (err, client) => {
  console.error('❌ Unexpected error on idle PostgreSQL client:', err.message);
  // Don't exit process in production, just log the error
  if (process.env.NODE_ENV !== 'production') {
    console.error('Full error:', err);
  }
});

// Graceful shutdown - close all connections on app termination
process.on('SIGTERM', () => {
  console.log('SIGTERM received, closing database pool...');
  pool.end(() => {
    console.log('Database pool closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received, closing database pool...');
  pool.end(() => {
    console.log('Database pool closed');
    process.exit(0);
  });
});

// Export pool and query function
module.exports = {
  query: (text, params) => pool.query(text, params),
  pool: pool
};