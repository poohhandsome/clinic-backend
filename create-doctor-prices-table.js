const db = require('./db');

async function createDoctorPricesTable() {
    try {
        console.log('Creating doctor_common_prices table...');

        await db.query(`
            CREATE TABLE IF NOT EXISTS doctor_common_prices (
                id SERIAL PRIMARY KEY,
                doctor_id INTEGER NOT NULL REFERENCES doctors_identities(doctor_id),
                treatment_id INTEGER NOT NULL REFERENCES treatments(treatment_id),
                custom_price NUMERIC(10, 2) NOT NULL,
                frequency_count INTEGER DEFAULT 1,
                last_used_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                UNIQUE(doctor_id, treatment_id, custom_price)
            )
        `);

        console.log('✅ Table created successfully');

        // Create index for faster queries
        await db.query(`
            CREATE INDEX IF NOT EXISTS idx_doctor_treatment_freq
            ON doctor_common_prices(doctor_id, treatment_id, frequency_count DESC)
        `);

        console.log('✅ Index created');

        process.exit(0);
    } catch (error) {
        console.error('❌ Error:', error.message);
        process.exit(1);
    }
}

createDoctorPricesTable();
