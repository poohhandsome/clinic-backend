const db = require('./db');

async function addStatusColumn() {
    try {
        console.log('Adding status column to visit_treatments table...');

        await db.query(`
            ALTER TABLE visit_treatments
            ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'completed'
        `);

        console.log('✅ Successfully added status column');

        // Verify the column was added
        const result = await db.query(`
            SELECT column_name, data_type, column_default
            FROM information_schema.columns
            WHERE table_name = 'visit_treatments'
            AND column_name = 'status'
        `);

        console.log('Verification:');
        result.rows.forEach(row => {
            console.log(`  - ${row.column_name}: ${row.data_type} (default: ${row.column_default})`);
        });

        process.exit(0);
    } catch (error) {
        console.error('❌ Error adding column:', error.message);
        process.exit(1);
    }
}

addStatusColumn();
