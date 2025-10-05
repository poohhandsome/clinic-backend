const db = require('./db');

async function changeStatusDefault() {
    try {
        console.log('Changing visit_treatments status column default from completed to NULL...');

        await db.query(`
            ALTER TABLE visit_treatments
            ALTER COLUMN status SET DEFAULT NULL
        `);

        console.log('✅ Successfully changed default to NULL');

        // Also update existing 'completed' records that don't have a treatment_record (likely just added)
        const result = await db.query(`
            UPDATE visit_treatments
            SET status = NULL
            WHERE status = 'completed' AND treatment_record IS NULL
            RETURNING visit_treatment_id
        `);

        console.log(`✅ Updated ${result.rowCount} existing treatments from 'completed' to NULL`);

        process.exit(0);
    } catch (error) {
        console.error('❌ Error:', error.message);
        process.exit(1);
    }
}

changeStatusDefault();
