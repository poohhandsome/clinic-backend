const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: true }
});

pool.query(`
  SELECT column_name, data_type, character_maximum_length
  FROM information_schema.columns
  WHERE table_name = 'visit_treatments'
  ORDER BY ordinal_position
`).then(result => {
  console.log('visit_treatments table schema:');
  result.rows.forEach(col => {
    const length = col.character_maximum_length ? ` (${col.character_maximum_length})` : '';
    console.log(`  ${col.column_name.padEnd(30)} | ${col.data_type}${length}`);
  });
  pool.end();
}).catch(err => {
  console.error('Error:', err.message);
  pool.end();
});
