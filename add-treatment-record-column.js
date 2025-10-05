const db = require('./db');

async function addTreatmentRecordColumn() {
    try {
        console.log('Adding treatment_record column to visit_treatments table...');

        await db.query(`
            ALTER TABLE visit_treatments
            ADD COLUMN IF NOT EXISTS treatment_record TEXT,
            ADD COLUMN IF NOT EXISTS recorded_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        `);

        console.log('✅ Successfully added treatment_record and recorded_at columns');

        // Verify the columns were added
        const result = await db.query(`
            SELECT column_name, data_type
            FROM information_schema.columns
            WHERE table_name = 'visit_treatments'
            AND column_name IN ('treatment_record', 'recorded_at')
        `);

        console.log('Verification:');
        result.rows.forEach(row => {
            console.log(`  - ${row.column_name}: ${row.data_type}`);
        });

        process.exit(0);
    } catch (error) {
        console.error('❌ Error adding columns:', error.message);
        process.exit(1);
    }
}

addTreatmentRecordColumn();
