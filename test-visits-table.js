require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: process.env.NODE_ENV === 'production' ? true : false
    }
});

async function testVisitsTable() {
    try {
        console.log('🔍 Checking if visits table exists...\n');

        // Check if visits table exists
        const tableCheck = await pool.query(`
            SELECT EXISTS (
                SELECT FROM information_schema.tables
                WHERE table_schema = 'public'
                AND table_name = 'visits'
            );
        `);

        if (tableCheck.rows[0].exists) {
            console.log('✅ visits table exists');

            // Check table structure
            const columns = await pool.query(`
                SELECT column_name, data_type, is_nullable
                FROM information_schema.columns
                WHERE table_name = 'visits'
                ORDER BY ordinal_position;
            `);

            console.log('\n📋 Table structure:');
            columns.rows.forEach(col => {
                console.log(`  - ${col.column_name}: ${col.data_type} ${col.is_nullable === 'NO' ? '(required)' : ''}`);
            });

            // Check if there are any visits
            const count = await pool.query('SELECT COUNT(*) FROM visits');
            console.log(`\n📊 Total visits in database: ${count.rows[0].count}`);

            // Check waiting visits
            const waiting = await pool.query("SELECT COUNT(*) FROM visits WHERE status = 'waiting'");
            console.log(`   Waiting visits: ${waiting.rows[0].count}`);

        } else {
            console.log('❌ visits table does NOT exist!');
            console.log('\n⚠️  You need to run the migration:');
            console.log('   node migrations/run-migration.js');
        }

    } catch (err) {
        console.error('❌ Error:', err.message);
    } finally {
        await pool.end();
    }
}

testVisitsTable();
