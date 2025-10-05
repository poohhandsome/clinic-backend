const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function addPaymentFields() {
  const client = await pool.connect();
  try {
    console.log('Adding payment fields to billing table...');

    // Add amount_paid and transaction_ref columns to billing table
    await client.query(`
      ALTER TABLE billing
      ADD COLUMN IF NOT EXISTS amount_paid DECIMAL(10,2),
      ADD COLUMN IF NOT EXISTS transaction_ref VARCHAR(255),
      ADD COLUMN IF NOT EXISTS processed_by INTEGER REFERENCES doctors_identities(doctor_id);
    `);

    console.log('✅ Payment fields added successfully!');
  } catch (err) {
    console.error('❌ Error adding payment fields:', err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

addPaymentFields();
