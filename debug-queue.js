require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: process.env.NODE_ENV === 'production' ? true : false
    }
});

async function debugQueue() {
    try {
        console.log('🔍 Debugging Doctor Queue...\n');

        // Check all visits
        const allVisits = await pool.query(`
            SELECT v.visit_id, v.patient_id, v.doctor_id, v.clinic_id, v.status,
                   v.check_in_time, v.waiting_alert_level,
                   p.first_name_th, p.last_name_th
            FROM visits v
            JOIN patients p ON v.patient_id = p.patient_id
            ORDER BY v.check_in_time DESC
            LIMIT 10
        `);

        console.log('📋 Recent visits (last 10):');
        if (allVisits.rows.length === 0) {
            console.log('   ❌ No visits found in database!');
        } else {
            allVisits.rows.forEach(v => {
                console.log(`   - Visit ${v.visit_id}: ${v.first_name_th} ${v.last_name_th}`);
                console.log(`     Patient: ${v.patient_id}, Doctor: ${v.doctor_id || 'NOT ASSIGNED'}, Clinic: ${v.clinic_id}`);
                console.log(`     Status: ${v.status}, Alert: ${v.waiting_alert_level || 'none'}`);
                console.log(`     Check-in: ${v.check_in_time}`);
                console.log('');
            });
        }

        // Check waiting visits
        console.log('\n📊 Waiting visits:');
        const waiting = await pool.query(`
            SELECT COUNT(*) as count FROM visits WHERE status = 'waiting'
        `);
        console.log(`   Total: ${waiting.rows[0].count}`);

        // Check doctor assignment
        console.log('\n👨‍⚕️ Doctor assignments:');
        const doctorVisits = await pool.query(`
            SELECT v.doctor_id, di.full_name, COUNT(*) as visit_count
            FROM visits v
            LEFT JOIN doctors_identities di ON v.doctor_id = di.doctor_id
            WHERE v.status IN ('waiting', 'in_progress')
            GROUP BY v.doctor_id, di.full_name
        `);

        if (doctorVisits.rows.length === 0) {
            console.log('   ❌ No waiting/in_progress visits assigned to any doctor');
        } else {
            doctorVisits.rows.forEach(d => {
                console.log(`   - Doctor ${d.doctor_id} (${d.full_name || 'UNASSIGNED'}): ${d.visit_count} visits`);
            });
        }

        // Test the exact query used by the API
        console.log('\n🔍 Testing API query for doctor_id=9, clinic_id=1:');
        const apiTest = await pool.query(`
            SELECT v.visit_id, v.patient_id, v.check_in_time, v.status,
                   v.waiting_alert_level as alert_level,
                   p.dn, p.first_name_th, p.last_name_th, p.date_of_birth,
                   p.chronic_diseases, p.allergies, p.extreme_care_drugs, p.is_pregnant
            FROM visits v
            JOIN patients p ON v.patient_id = p.patient_id
            WHERE v.clinic_id = $1 AND v.doctor_id = $2 AND v.status IN ('waiting', 'in_progress')
            ORDER BY v.waiting_alert_level DESC NULLS LAST, v.check_in_time ASC
        `, [1, 9]);

        if (apiTest.rows.length === 0) {
            console.log('   ❌ No results! This is what the API returns (empty array)');
            console.log('\n💡 Possible issues:');
            console.log('   1. No visits exist with doctor_id = 9');
            console.log('   2. Visit status is not "waiting" or "in_progress"');
            console.log('   3. Clinic ID mismatch');
        } else {
            console.log(`   ✅ Found ${apiTest.rows.length} visit(s):`);
            apiTest.rows.forEach(v => {
                console.log(`      - ${v.first_name_th} ${v.last_name_th} (DN: ${v.dn})`);
            });
        }

    } catch (err) {
        console.error('❌ Error:', err.message);
    } finally {
        await pool.end();
    }
}

debugQueue();
