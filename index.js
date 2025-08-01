// index.js (REPLACE)

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { format, addMonths, startOfMonth, getDay, eachDayOfInterval, addDays, endOfMonth, getWeekOfMonth } = require('date-fns');
const db = require('./db');

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// --- Authentication Routes ---
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const { rows } = await db.query('SELECT * FROM workers WHERE username = $1', [username]);
        if (rows.length === 0) return res.status(400).json({ msg: 'Invalid credentials' });
        const user = rows[0];
        const isMatch = await bcrypt.compare(password, user.password_hash);
        if (!isMatch) return res.status(400).json({ msg: 'Invalid credentials' });
        const payload = { user: { id: user.id, username: user.username } };
        jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '12h' }, (err, token) => {
            if (err) throw err;
            res.json({ token, user: { id: user.id, username: user.username } });
        });
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ message: err.message || 'Server Error' });
    }
});

// --- Auth Middleware ---
const authMiddleware = (req, res, next) => {
    const authHeader = req.header('Authorization');
    if (!authHeader) return res.status(401).json({ msg: 'No token, authorization denied' });
    try {
        const token = authHeader.split(' ')[1];
        req.user = jwt.verify(token, process.env.JWT_SECRET).user;
        next();
    } catch (err) {
        res.status(401).json({ msg: 'Token is not valid' });
    }
};

// --- API Endpoints ---
app.get('/api/clinics', authMiddleware, async (req, res) => {
    try {
        const { rows } = await db.query('SELECT clinic_id as id, name FROM clinics ORDER BY name');
        res.json(rows);
    } catch (err) {
        res.status(500).json({ message: err.message || 'Server error' });
    }
});

app.get('/api/doctors/unique', authMiddleware, async (req, res) => {
    try {
        const query = `
            SELECT
                di.doctor_id AS id,
                di.full_name AS name,
                di.specialty,
                di.status,
                di.color,
                di.email,
                json_agg(json_build_object('id', c.clinic_id, 'name', c.name)) as clinics
            FROM doctors_identities di
            JOIN doctor_clinic_assignments dca ON di.doctor_id = dca.doctor_id
            JOIN clinics c ON dca.clinic_id = c.clinic_id
            GROUP BY di.doctor_id
            ORDER BY di.full_name;
        `;
        const { rows } = await db.query(query);
        res.json(rows);
    } catch (err) {
        console.error("Error in /api/doctors/unique:", err.message);
        res.status(500).json({ message: 'Server Error' });
    }
});

app.post('/api/doctors', authMiddleware, async (req, res) => {
    const { fullName, specialty, clinicIds, email, password, color, status } = req.body;
    if (!fullName || !clinicIds || !Array.isArray(clinicIds) || clinicIds.length === 0 || !email || !password) {
        return res.status(400).json({ message: 'Full name, clinic(s), email, and password are required.' });
    }
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');
        const salt = await bcrypt.genSalt(10);
        const passwordHash = await bcrypt.hash(password, salt);
        const identityResult = await client.query(
            'INSERT INTO doctors_identities (full_name, specialty, email, password_hash, color, status) VALUES ($1, $2, $3, $4, $5, $6) RETURNING doctor_id',
            [fullName.trim(), specialty || null, email, passwordHash, color || null, status || 'active']
        );
        const newDoctorId = identityResult.rows[0].doctor_id;
        const assignmentPromises = clinicIds.map(clinicId => {
            return client.query(
                'INSERT INTO doctor_clinic_assignments (doctor_id, clinic_id) VALUES ($1, $2)',
                [newDoctorId, clinicId]
            );
        });
        await Promise.all(assignmentPromises);
        await client.query('COMMIT');
        res.status(201).json({ message: `Doctor '${fullName}' created successfully.` });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Error in POST /api/doctors:", err.message);
        if (err.code === '23505') {
            return res.status(409).json({ message: 'A doctor with this email already exists, or is already assigned to one of these clinics.' });
        }
        res.status(500).json({ message: 'Server Error' });
    } finally {
        client.release();
    }
});

app.put('/api/doctors/:id', authMiddleware, async (req, res) => {
    const { id } = req.params;
    const { clinicIds, specialty, email, color, status, password } = req.body;
    if (!Array.isArray(clinicIds)) {
        return res.status(400).json({ message: 'clinicIds must be an array.' });
    }
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');
        let passwordHash;
        if (password) {
            const salt = await bcrypt.genSalt(10);
            passwordHash = await bcrypt.hash(password, salt);
            await client.query(
                'UPDATE doctors_identities SET specialty = $1, email = $2, color = $3, status = $4, password_hash = $5 WHERE doctor_id = $6',
                [specialty, email, color, status, passwordHash, id]
            );
        } else {
             await client.query(
                'UPDATE doctors_identities SET specialty = $1, email = $2, color = $3, status = $4 WHERE doctor_id = $5',
                [specialty, email, color, status, id]
            );
        }
        const { rows: currentAssignments } = await client.query('SELECT clinic_id FROM doctor_clinic_assignments WHERE doctor_id = $1', [id]);
        const currentClinicIds = currentAssignments.map(a => a.clinic_id);
        const clinicsToAdd = clinicIds.filter(cid => !currentClinicIds.includes(cid));
        const clinicsToRemove = currentClinicIds.filter(cid => !clinicIds.includes(cid));
        if (clinicsToRemove.length > 0) {
            await client.query('DELETE FROM doctor_clinic_assignments WHERE doctor_id = $1 AND clinic_id = ANY($2::int[])', [id, clinicsToRemove]);
        }
        const addPromises = clinicsToAdd.map(clinicId => {
            return client.query('INSERT INTO doctor_clinic_assignments (doctor_id, clinic_id) VALUES ($1, $2)', [id, clinicId]);
        });
        await Promise.all(addPromises);
        await client.query('COMMIT');
        res.json({ message: `Doctor assignments updated successfully.` });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Error in PUT /api/doctors/:id:", err.message);
        if (err.code === '23505') {
            return res.status(409).json({ message: 'This email is already in use by another doctor or the clinic assignment is a duplicate.' });
        }
        res.status(500).json({ message: 'Server Error' });
    } finally {
        client.release();
    }
});

// --- Patient Endpoints ---
app.post('/api/patients', authMiddleware, async (req, res) => {
    const {
        dn, dn_old, id_verification_type, id_number, title_th, first_name_th, last_name_th,
        title_en, first_name_en, last_name_en, nickname, gender, date_of_birth,
        chronic_diseases, allergies, mobile_phone, home_phone, line_id, email,
        address, sub_district, district, province, country, zip_code
    } = req.body;
    try {
        const { rows } = await db.query(
            `INSERT INTO patients (dn, dn_old, id_verification_type, id_number, title_th, first_name_th, last_name_th, title_en, first_name_en, last_name_en, nickname, gender, date_of_birth, chronic_diseases, allergies, mobile_phone, home_phone, line_id, email, address, sub_district, district, province, country, zip_code)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25) RETURNING *`,
            [dn, dn_old, id_verification_type, id_number, title_th, first_name_th, last_name_th, title_en, first_name_en, last_name_en, nickname, gender, date_of_birth, chronic_diseases, allergies, mobile_phone, home_phone, line_id, email, address, sub_district, district, province, country, zip_code]
        );
        res.status(201).json(rows[0]);
    } catch (err) {
        console.error("Error in POST /api/patients:", err.message);
        res.status(500).json({ message: 'Server Error' });
    }
});

app.get('/api/patients', authMiddleware, async (req, res) => {
    const { query } = req.query;
    try {
        const search_query = `%${query}%`;
        const { rows } = await db.query(
            `SELECT patient_id, dn, dn_old, first_name_th, last_name_th, mobile_phone FROM patients
             WHERE first_name_th ILIKE $1 OR last_name_th ILIKE $1 OR mobile_phone ILIKE $1 OR dn ILIKE $1`,
            [search_query]
        );
        res.json(rows);
    } catch (err) {
        console.error("Error in GET /api/patients:", err.message);
        res.status(500).json({ message: 'Server Error' });
    }
});
// Note: Other endpoints below are simplified as they mostly rely on doctor_id, which we migrated.
// ... (rest of the file remains largely the same, but ensure doctor_id is referenced correctly)

app.get('/api/clinic-day-schedule', authMiddleware, async (req, res) => {
    const { clinic_id, date } = req.query;
    if (!clinic_id || !date) return res.status(400).json({ msg: 'Clinic ID and date are required' });

    try {
        const targetDate = new Date(date);
        const dayOfWeek = getDay(targetDate);
        const weekOfMonth = getWeekOfMonth(targetDate);

        // Base weekly schedule for doctors in this clinic
        let query = `
            SELECT di.doctor_id AS id, di.full_name AS name, di.specialty, da.start_time, da.end_time
            FROM doctors_identities di
            JOIN doctor_availability da ON di.doctor_id = da.doctor_id
            WHERE da.clinic_id = $1 AND da.day_of_week = $2 AND di.status = 'active'
        `;
        const { rows: weeklyDoctors } = await db.query(query, [clinic_id, dayOfWeek]);

        // Recurring rules for doctors in this clinic
        query = `
            SELECT di.doctor_id AS id, di.full_name AS name, di.specialty, dr.start_time, dr.end_time
            FROM doctors_identities di
            JOIN doctor_availability_rules dr ON di.doctor_id = dr.doctor_id
            WHERE dr.clinic_id = $1 AND dr.day_of_week = $2 AND $3 = ANY(dr.weeks_of_month) AND di.status = 'active'
        `;
        const { rows: ruleDoctors } = await db.query(query, [clinic_id, dayOfWeek, weekOfMonth]);

        const workingDoctorsMap = new Map();
        [...weeklyDoctors, ...ruleDoctors].forEach(doc => workingDoctorsMap.set(doc.id, doc));
        const workingDoctors = Array.from(workingDoctorsMap.values());
        
        const { rows: specialSchedules } = await db.query(
            `SELECT doctor_id, is_available FROM special_schedules WHERE schedule_date = $1`, [date]
        );

        const finalWorkingDoctors = workingDoctors.filter(doc => {
            const special = specialSchedules.find(s => s.doctor_id === doc.id);
            return !special || special.is_available;
        });

        const { rows: allDoctors } = await db.query(
            `SELECT di.doctor_id AS id, di.full_name AS name 
             FROM doctors_identities di
             JOIN doctor_clinic_assignments dca ON di.doctor_id = dca.doctor_id
             WHERE dca.clinic_id = $1
             ORDER BY di.full_name`, [clinic_id]
        );

        const { rows: appointments } = await db.query(
            `SELECT a.appointment_id AS id, a.doctor_id, a.customer_id,
                    TO_CHAR(a.appointment_time, 'HH24:MI') AS appointment_time,
                    TO_CHAR(a.appointment_time + INTERVAL '30 minutes', 'HH24:MI') AS end_time,
                    a.status, COALESCE(a.patient_name_at_booking, c.display_name, 'Unknown') AS patient_name_at_booking
             FROM appointments a LEFT JOIN customers c ON a.customer_id = c.customer_id
             WHERE a.clinic_id = $1 AND DATE(a.appointment_time) = $2 AND LOWER(a.status) = 'confirmed'`,
            [clinic_id, date]
        );

        res.json({
            doctors: finalWorkingDoctors,
            all_doctors_in_clinic: allDoctors,
            appointments: appointments,
        });

    } catch (err) {
        console.error("Error in /api/clinic-day-schedule:", err.message);
        res.status(500).json({ message: 'Server Error' });
    }
});


app.get('/api/doctor-work-schedule/:doctor_id', authMiddleware, async (req, res) => {
    try {
        const { doctor_id } = req.params;

        const { rows: doctorRecords } = await db.query(
            `SELECT dca.clinic_id, c.name as clinic_name FROM doctor_clinic_assignments dca 
             JOIN clinics c ON dca.clinic_id = c.clinic_id WHERE dca.doctor_id = $1`, [doctor_id]
        );
        
        const availabilityResult = await db.query('SELECT clinic_id, day_of_week, start_time, end_time FROM doctor_availability WHERE doctor_id = $1', [doctor_id]);
        const rulesResult = await db.query('SELECT clinic_id, day_of_week, weeks_of_month, start_time, end_time FROM doctor_availability_rules WHERE doctor_id = $1', [doctor_id]);
        const specialSchedulesResult = await db.query('SELECT doctor_id, schedule_date, is_available FROM special_schedules WHERE doctor_id = $1', [doctor_id]);

        const scheduleMap = new Map();
        const startDate = new Date();
        const endDate = addMonths(startDate, 2); 

        eachDayOfInterval({ start: startDate, end: endDate }).forEach(day => {
            const dayOfWeek = getDay(day);
            const dateString = format(day, 'yyyy-MM-dd');
            const weekOfMonth = getWeekOfMonth(day);
            let isWorking = false;
            let schedule = {};

            const weeklyAvail = availabilityResult.rows.find(a => a.day_of_week === dayOfWeek);
            if (weeklyAvail) {
                isWorking = true;
                const clinicInfo = doctorRecords.find(c => c.clinic_id === weeklyAvail.clinic_id);
                schedule = { startTime: weeklyAvail.start_time, endTime: weeklyAvail.end_time, clinicId: clinicInfo.clinic_id, clinicName: clinicInfo.clinic_name };
            }

            const rule = rulesResult.rows.find(r => r.day_of_week === dayOfWeek && r.weeks_of_month.includes(weekOfMonth));
             if (rule) {
                isWorking = true;
                const clinicInfo = doctorRecords.find(c => c.clinic_id === rule.clinic_id);
                schedule = { startTime: rule.start_time, endTime: rule.end_time, clinicId: clinicInfo.clinic_id, clinicName: clinicInfo.clinic_name };
            }
            
            const special = specialSchedulesResult.rows.find(s => format(s.schedule_date, 'yyyy-MM-dd') === dateString);
            if(special && !special.is_available) {
                isWorking = false;
            }

            if(isWorking) {
                scheduleMap.set(dateString, { date: dateString, ...schedule });
            }
        });

        const workingDays = Array.from(scheduleMap.values()).sort((a,b) => new Date(a.date) - new Date(b.date));
        res.json(workingDays);

    } catch (err) {
        console.error("Error calculating work schedule:", err.message);
        res.status(500).json({ message: 'Server Error' });
    }
});


app.get('/api/doctor-availability/:doctor_id', authMiddleware, async (req, res) => {
    const { doctor_id } = req.params;
    try {
        const { rows } = await db.query(
            `SELECT da.id, da.day_of_week, da.start_time, da.end_time, da.clinic_id, c.name as clinic_name
             FROM doctor_availability da 
             JOIN clinics c ON da.clinic_id = c.clinic_id
             WHERE da.doctor_id = $1`,
            [doctor_id]
        );
        res.json(rows);
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ message: 'Server Error' });
    }
});


app.post('/api/doctor-availability/:doctor_id', authMiddleware, async (req, res) => {
    const { doctor_id } = req.params;
    const { availability } = req.body; // Expects an array with a single schedule object
    const slot = availability[0];
    try {
        await db.query(
            'INSERT INTO doctor_availability (doctor_id, clinic_id, day_of_week, start_time, end_time) VALUES ($1, $2, $3, $4, $5)',
            [doctor_id, slot.clinic_id, slot.day_of_week, slot.start_time, slot.end_time]
        );
        res.status(201).send({ message: 'Availability added successfully' });
    } catch (err) {
        console.error("Error saving availability:", err.message);
        res.status(500).send('Server Error');
    }
});


app.get('/api/doctor-rules/:doctor_id', authMiddleware, async(req, res) => {
    const { doctor_id } = req.params;
     try {
        const { rows } = await db.query(
            `SELECT r.id, r.day_of_week, r.weeks_of_month, r.start_time, r.end_time, r.clinic_id, c.name as clinic_name
             FROM doctor_availability_rules r
             JOIN clinics c ON r.clinic_id = c.clinic_id
             WHERE r.doctor_id = $1`,
            [doctor_id]
        );
        res.json(rows);
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ message: 'Server Error' });
    }
});

app.post('/api/doctor-rules/:doctor_id', authMiddleware, async(req, res) => {
    const { doctor_id } = req.params;
    const { clinic_id, day_of_week, weeks_of_month, start_time, end_time } = req.body;
    try {
        await db.query(
            'INSERT INTO doctor_availability_rules (doctor_id, clinic_id, day_of_week, weeks_of_month, start_time, end_time) VALUES ($1, $2, $3, $4, $5, $6)',
            [doctor_id, clinic_id, day_of_week, weeks_of_month, start_time, end_time]
        );
        res.status(201).json({ message: 'Rule created successfully.' });
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ message: 'Server Error' });
    }
});

app.delete('/api/doctor-rules/:rule_id', authMiddleware, async(req, res) => {
    const { rule_id } = req.params;
    try {
        await db.query('DELETE FROM doctor_availability_rules WHERE id = $1', [rule_id]);
        res.status(200).json({ message: 'Rule deleted successfully.' });
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ message: 'Server Error' });
    }
});


// --- Other Endpoints ---
app.get('/api/pending-appointments', authMiddleware, async (req, res) => {
    const { clinic_id } = req.query;
    try {
        const { rows } = await db.query(`
            SELECT a.appointment_id AS id, TO_CHAR(a.appointment_time, 'YYYY-MM-DD') AS appointment_date,
                   TO_CHAR(a.appointment_time, 'HH24:MI:SS') AS appointment_time, 
                   COALESCE(a.patient_name_at_booking, c.display_name, 'Unknown Patient') AS patient_name, 
                   di.full_name AS doctor_name 
            FROM appointments a 
            JOIN doctors_identities di ON a.doctor_id = di.doctor_id
            LEFT JOIN customers c ON a.customer_id = c.customer_id 
            WHERE a.clinic_id = $1 AND LOWER(a.status) = 'pending_confirmation'
        `, [clinic_id]);
        res.json(rows);
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ message: err.message || 'Server Error' });
    }
});
// --- Appointment & Schedule Endpoints ---
app.get('/api/all-appointments', authMiddleware, async (req, res) => {
    const { clinic_id, startDate, endDate } = req.query;
    try {
        const { rows } = await db.query(`
            SELECT 
                a.appointment_id as id,
                a.doctor_id,
                TO_CHAR(a.appointment_time, 'YYYY-MM-DD') AS appointment_date,
                TO_CHAR(a.appointment_time, 'HH24:MI:SS') as booking_time,
                a.status,
                COALESCE(a.patient_name_at_booking, c.display_name, 'Unknown Patient') as patient_name,
                COALESCE(a.patient_phone_at_booking, c.phone_number, 'N/A') as phone_number,
                di.full_name as doctor_name
            FROM appointments a
            JOIN doctors_identities di ON a.doctor_id = di.doctor_id
            LEFT JOIN customers c ON a.customer_id = c.customer_id
            WHERE a.clinic_id = $1
              AND DATE(a.appointment_time) BETWEEN $2 AND $3
            ORDER BY a.appointment_time
        `, [clinic_id, startDate, endDate]);
        res.json(rows);
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ message: 'Server Error' });
    }
});

// ***************************************************************
// ** NEW ENDPOINT: Update any detail of an appointment **
// ***************************************************************
app.put('/api/appointments/:id', authMiddleware, async (req, res) => {
    const { id } = req.params;
    const { doctor_id, appointment_date, appointment_time, status } = req.body;
    try {
        const appointmentTimestamp = `${appointment_date} ${appointment_time}`;
        const { rows } = await db.query(
            `UPDATE appointments 
             SET doctor_id = $1, appointment_time = $2, status = $3
             WHERE appointment_id = $4 RETURNING *`,
            [doctor_id, appointmentTimestamp, status, id]
        );
        res.json(rows[0]);
    } catch (err) {
        console.error("Error in PUT /api/appointments/:id:", err.message);
        res.status(500).json({ message: err.message || 'Server Error' });
    }
});


app.get('/api/confirmed-appointments', authMiddleware, async (req, res) => {
    const { clinic_id, startDate, endDate } = req.query;
    try {
        const { rows } = await db.query(`
            SELECT a.appointment_id as id, a.doctor_id,
                   TO_CHAR(a.appointment_time, 'YYYY-MM-DD') AS appointment_date,
                   TO_CHAR(a.appointment_time, 'HH24:MI:SS') as booking_time, a.status,
                   COALESCE(a.patient_name_at_booking, c.display_name, 'Unknown Patient') as patient_name,
                   COALESCE(a.patient_phone_at_booking, c.phone_number, 'N/A') as phone_number,
                   di.full_name as doctor_name
            FROM appointments a 
            JOIN doctors_identities di ON a.doctor_id = di.doctor_id
            LEFT JOIN customers c ON a.customer_id = c.customer_id
            WHERE a.clinic_id = $1 AND LOWER(a.status) = 'confirmed' AND DATE(a.appointment_time) BETWEEN $2 AND $3
            ORDER BY a.appointment_time
        `, [clinic_id, startDate, endDate]);
        res.json(rows);
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ message: err.message || 'Server Error' });
    }
});

app.patch('/api/appointments/:id', authMiddleware, async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;
    try {
        const { rows } = await db.query('UPDATE appointments SET status = $1 WHERE appointment_id = $2 RETURNING *', [status, id]);
        res.json(rows[0]);
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ message: err.message || 'Server Error' });
    }
});

app.post('/api/appointments', authMiddleware, async (req, res) => {
    const { customer_id, doctor_id, clinic_id, appointment_date, appointment_time, status } = req.body;
    if (!customer_id || !doctor_id || !clinic_id || !appointment_date || !appointment_time) {
        return res.status(400).json({ msg: 'Missing required appointment details.' });
    }
    try {
        const appointmentTimestamp = `${appointment_date} ${appointment_time}`;
        const { rows: customerRows } = await db.query('SELECT display_name, phone_number FROM customers WHERE customer_id = $1', [customer_id]);
        const customerName = customerRows.length > 0 ? customerRows[0].display_name : 'N/A';
        const customerPhone = customerRows.length > 0 ? customerRows[0].phone_number : 'N/A';
        const { rows } = await db.query(
            `INSERT INTO appointments (customer_id, doctor_id, clinic_id, appointment_time, status, patient_name_at_booking, patient_phone_at_booking)
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
            [customer_id, doctor_id, clinic_id, appointmentTimestamp, status || 'confirmed', customerName, customerPhone]
        );
        res.status(201).json(rows[0]);
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ message: err.message || 'Server Error' });
    }
});

app.get('/api/special-schedules/:doctor_id', authMiddleware, async (req, res) => {
    const { doctor_id } = req.params;
    try {
        const query = `
            SELECT ss.id, ss.doctor_id, ss.clinic_id, c.name as clinic_name,
                   TO_CHAR(ss.schedule_date, 'YYYY-MM-DD') as schedule_date,
                   ss.start_time, ss.end_time, ss.is_available
            FROM special_schedules ss JOIN clinics c ON ss.clinic_id = c.clinic_id
            WHERE ss.doctor_id = $1 AND ss.is_available = false
            ORDER BY ss.schedule_date DESC;
        `;
        const { rows } = await db.query(query, [doctor_id]);
        res.json(rows);
    } catch (err) {
        console.error("Error fetching special schedules:", err.message);
        res.status(500).json({ message: 'Server Error' });
    }
});

app.post('/api/special-schedules', authMiddleware, async (req, res) => {
    const { doctor_id, clinic_id, schedule_date, is_available } = req.body;
    if (!doctor_id || !clinic_id || !schedule_date) return res.status(400).json({ message: 'Doctor, clinic, and date are required.' });

    try {
        await db.query(
            `INSERT INTO special_schedules (doctor_id, clinic_id, schedule_date, is_available)
             VALUES ($1, $2, $3, $4) ON CONFLICT (doctor_id, schedule_date) DO UPDATE SET is_available = EXCLUDED.is_available`,
            [doctor_id, clinic_id, schedule_date, is_available]
        );
        res.status(201).json({ message: 'Special schedule created successfully.' });
    } catch (err) {
        console.error("Error in POST /api/special-schedules:", err.message);
        res.status(500).json({ message: 'Server Error' });
    }
});


app.delete('/api/special-schedules/:id', authMiddleware, async (req, res) => {
    const { id } = req.params;
    try {
        await db.query('DELETE FROM special_schedules WHERE id = $1', [id]);
        res.status(200).json({ message: 'Special schedule deleted successfully.' });
    } catch (err) {
        console.error("Error deleting special schedule:", err.message);
        res.status(500).json({ message: 'Server Error' });
    }
});

app.listen(port, () => {
    console.log(`✅ Server started on port ${port}`);
});