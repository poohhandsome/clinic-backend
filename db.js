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
  max: 20, // Maximum number of clients in pool
  idleTimeoutMillis: 30000, // Close idle clients after 30 seconds
  connectionTimeoutMillis: 2000, // Return error after 2 seconds if unable to connect
});

// Handle pool errors to prevent application crashes
pool.on('error', (err, client) => {
  console.error('Unexpected error on idle PostgreSQL client:', err);
  // Don't exit process in production, just log the error
  if (process.env.NODE_ENV !== 'production') {
    process.exit(-1);
  }
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool: pool
};