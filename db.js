
/* -------------------------------------------------- */
/* FILE 1: db.js (Database Connection) - UPDATED      */
/* -------------------------------------------------- */

const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Neon requires SSL
  ssl: {
    rejectUnauthorized: false
  }
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  // **THE FIX IS HERE**: We now also export the pool itself
  // so other parts of the app can create transactions.
  pool: pool
};
