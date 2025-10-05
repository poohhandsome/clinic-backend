const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function createCompensationRulesTable() {
  const client = await pool.connect();
  try {
    console.log('Creating compensation_rules table...');

    await client.query(`
      CREATE TABLE IF NOT EXISTS compensation_rules (
        rule_id SERIAL PRIMARY KEY,
        clinic_id INTEGER NOT NULL REFERENCES clinics(clinic_id) ON DELETE CASCADE,
        treatment_id INTEGER REFERENCES treatments(treatment_id) ON DELETE CASCADE,
        rule_type VARCHAR(20) NOT NULL CHECK (rule_type IN ('percentage', 'fixed', 'default')),
        value DECIMAL(10,2) NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        UNIQUE(clinic_id, treatment_id)
      );
    `);

    console.log('✅ compensation_rules table created successfully!');

    // Create index for faster lookups
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_compensation_rules_clinic
      ON compensation_rules(clinic_id);
    `);

    console.log('✅ Index created successfully!');

  } catch (err) {
    console.error('❌ Error creating compensation_rules table:', err);
    throw err;
  } finally{
    client.release();
    await pool.end();
  }
}

createCompensationRulesTable();
