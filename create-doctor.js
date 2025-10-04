require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcrypt');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: process.env.NODE_ENV === 'production' ? true : false
    }
});

async function createDoctorAccount() {
    const client = await pool.connect();

    try {
        console.log('🔐 Creating doctor account...\n');

        // Hash password
        const password = 'Doctor123';
        const passwordHash = await bcrypt.hash(password, 10);

        await client.query('BEGIN');

        // Create doctor identity
        const doctorResult = await client.query(
            `INSERT INTO doctors_identities (full_name, specialty, email, password_hash, color, status)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING doctor_id`,
            ['Dr. Test Doctor', 'General Practice', 'doctor@clinic.com', passwordHash, '#3B82F6', 'active']
        );

        const doctorId = doctorResult.rows[0].doctor_id;
        console.log(`✅ Doctor created with ID: ${doctorId}`);

        // Get first clinic
        const clinicResult = await client.query('SELECT clinic_id FROM clinics ORDER BY clinic_id LIMIT 1');

        if (clinicResult.rows.length > 0) {
            const clinicId = clinicResult.rows[0].clinic_id;

            // Assign doctor to clinic
            await client.query(
                'INSERT INTO doctor_clinic_assignments (doctor_id, clinic_id) VALUES ($1, $2)',
                [doctorId, clinicId]
            );

            console.log(`✅ Doctor assigned to clinic ID: ${clinicId}`);
        } else {
            console.log('⚠️  No clinics found. Please assign doctor to clinic manually.');
        }

        await client.query('COMMIT');

        console.log('\n✅ Doctor account created successfully!\n');
        console.log('Login credentials:');
        console.log('  Email: doctor@clinic.com');
        console.log('  Password: Doctor123');
        console.log('');

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('❌ Error creating doctor account:', err.message);

        if (err.code === '23505') {
            console.log('\n⚠️  Doctor with email doctor@clinic.com already exists!');
            console.log('Use these credentials:');
            console.log('  Email: doctor@clinic.com');
            console.log('  Password: Doctor123');
        }
    } finally {
        client.release();
        await pool.end();
    }
}

createDoctorAccount();
