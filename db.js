/* -------------------------------------------------- */
/* FILE 1: db.js (Database Connection)        */
/* -------------------------------------------------- */
// Create a file named 'db.js' and paste this code into it.

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
};