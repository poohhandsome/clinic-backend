require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function checkSchema() {
    console.log('Checking visits table schema...\n');

    const result = await pool.query(`
        SELECT column_name, data_type, character_maximum_length
        FROM information_schema.columns
        WHERE table_name = 'visits'
        ORDER BY ordinal_position
    `);

    console.log('VISITS TABLE COLUMNS:');
    result.rows.forEach(r => {
        const length = r.character_maximum_length ? ` (${r.character_maximum_length})` : '';
        console.log(`  ${r.column_name.padEnd(30)} | ${r.data_type}${length}`);
    });

    await pool.end();
}

checkSchema().catch(console.error);
