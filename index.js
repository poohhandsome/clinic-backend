// index.js (REPLACE)

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = 'bcrypt';
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
        const isMatch = await require('bcrypt').compare(password, user.password_hash);
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
        console.error(err.message);
        res.status(500).json({ message: err.message || 'Server error' });
    }
});

app.get('/api/doctors/unique', authMiddleware, async (req, res) => {
    try {
        const query = `
            SELECT
                d.full_name AS name,
                MIN(d.doctor_id) AS id,
                MIN(d.specialty) as specialty,
                MIN(d.status) as status,
                MIN(d.color) as color,
                MIN(d.email) as email,
                json_agg(json_build_object('id', c.clinic_id, 'name', c.name)) as clinics
            FROM doctors d
            JOIN clinics c ON d.clinic_id = c.clinic_id
            GROUP BY d.full_name
            ORDER BY d.full_name;
        `;
        const { rows } = await db.query(query);
        res.json(rows);
    } catch (err) {
        console.error("CRITICAL Error in /api/doctors/unique:", err.message);
        res.status(500).json({ message: err.message || 'Server Error' });
    }
});


app.get('/api/doctors', authMiddleware, async (req, res) => {
    const { clinic_id } = req.query;
    if (!clinic_id) {
        return res.status(400).json({ msg: 'A clinic_id is required.' });
    }
    try {
        const { rows } = await db.query(
            'SELECT doctor_id AS id, full_name AS name FROM doctors WHERE clinic_id = $1 ORDER BY full_name',
            [clinic_id]
        );
        res.json(rows);
    } catch (err) {
        console.error("Error in /api/doctors:", err.message);
        res.status(500).json({ message: err.message || 'Server Error' });
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
        const salt = await require('bcrypt').genSalt(10);
        const passwordHash = await require('bcrypt').hash(password, salt);

        const insertPromises = clinicIds.map(clinicId => {
            return client.query(
                'INSERT INTO doctors (full_name, specialty, clinic_id, email, password_hash, color, status) VALUES ($1, $2, $3, $4, $5, $6, $7)',
                [fullName.trim(), specialty || null, clinicId, email, passwordHash, color || null, status || 'active']
            );
        });

        await Promise.all(insertPromises);
        await client.query('COMMIT');
        res.status(201).json({ message: `Doctor '${fullName}' created successfully.` });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Error in POST /api/doctors:", err.message);
        if (err.code === '23505') {
            return res.status(409).json({ message: 'A doctor with this email or clinic assignment already exists.' });
        }
        res.status(500).json({ message: err.message || 'Server Error' });
    } finally {
        client.release();
    }
});

app.put('/api/doctors/:id/clinics', authMiddleware, async (req, res) => {
    const { id } = req.params;
    const { clinicIds, specialty, email, color, status, password } = req.body;

    if (!Array.isArray(clinicIds)) {
        return res.status(400).json({ message: 'clinicIds must be an array.' });
    }

    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');

        const nameResult = await client.query('SELECT full_name FROM doctors WHERE doctor_id = $1', [id]);
        if (nameResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Doctor not found.' });
        }
        const fullName = nameResult.rows[0].full_name;

        await client.query(
            'UPDATE doctors SET specialty = $1, email = $2, color = $3, status = $4 WHERE full_name = $5',
            [specialty, email, color, status, fullName]
        );
        
        if (password) {
            const salt = await require('bcrypt').genSalt(10);
            const passwordHash = await require('bcrypt').hash(password, salt);
            await client.query('UPDATE doctors SET password_hash = $1 WHERE full_name = $2', [passwordHash, fullName]);
        }

        const currentAssignmentsResult = await client.query('SELECT doctor_id, clinic_id FROM doctors WHERE full_name = $1', [fullName]);
        const currentClinicIds = currentAssignmentsResult.rows.map(a => a.clinic_id);
        
        const clinicsToAdd = clinicIds.filter(cid => !currentClinicIds.includes(cid));
        const doctorIdsToRemove = currentAssignmentsResult.rows
            .filter(a => !clinicIds.includes(a.clinic_id))
            .map(a => a.doctor_id);

        if (doctorIdsToRemove.length > 0) {
            await client.query('DELETE FROM doctors WHERE doctor_id = ANY($1::int[])', [doctorIdsToRemove]);
        }

        const addPromises = clinicsToAdd.map(clinicId => {
            return client.query('INSERT INTO doctors (full_name, specialty, clinic_id, email, color, status) VALUES ($1, $2, $3, $4, $5, $6)', 
            [fullName, specialty, clinicId, email, color, status]);
        });
        await Promise.all(addPromises);

        await client.query('COMMIT');
        res.json({ message: `Doctor '${fullName}' assignments updated.` });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Error in PUT /api/doctors/:id/clinics:", err.message);
        res.status(500).json({ message: err.message || 'Server Error' });
    } finally {
        client.release();
    }
});

app.get('/api/clinic-day-schedule', authMiddleware, async (req, res) => {
    const { clinic_id, date } = req.query;
    if (!clinic_id || !date) return res.status(400).json({ msg: 'Clinic ID and date are required' });

    try {
        const targetDate = new Date(date);
        const dayOfWeek = getDay(targetDate);
        const weekOfMonth = getWeekOfMonth(targetDate);

        // Base weekly schedule
        let query = `
            SELECT d.doctor_id AS id, d.full_name AS name, d.specialty, da.start_time, da.end_time
            FROM doctors d
            JOIN doctor_availability da ON d.doctor_id = da.doctor_id
            WHERE d.clinic_id = $1 AND da.day_of_week = $2 AND d.status = 'active'
        `;
        const { rows: weeklyDoctors } = await db.query(query, [clinic_id, dayOfWeek]);

        // Recurring rules for the specific week and day
        query = `
            SELECT d.doctor_id AS id, d.full_name AS name, d.specialty, dr.start_time, dr.end_time
            FROM doctors d
            JOIN doctor_availability_rules dr ON d.doctor_id = dr.doctor_id
            WHERE d.clinic_id = $1 AND dr.day_of_week = $2 AND $3 = ANY(dr.weeks_of_month) AND d.status = 'active'
        `;
        const { rows: ruleDoctors } = await db.query(query, [clinic_id, dayOfWeek, weekOfMonth]);

        // Combine and deduplicate doctors, giving precedence to recurring rules
        const workingDoctorsMap = new Map();
        [...weeklyDoctors, ...ruleDoctors].forEach(doc => workingDoctorsMap.set(doc.id, doc));
        const workingDoctors = Array.from(workingDoctorsMap.values());
        
        // Specific day overrides (vacations, etc.)
        const { rows: specialSchedules } = await db.query(
            `SELECT doctor_id, is_available FROM special_schedules WHERE schedule_date = $1`, [date]
        );

        // Filter out doctors who are unavailable
        const finalWorkingDoctors = workingDoctors.filter(doc => {
            const special = specialSchedules.find(s => s.doctor_id === doc.id);
            return !special || special.is_available;
        });

        // Fetch all doctors for the clinic for UI purposes
        const { rows: allDoctors } = await db.query(
            'SELECT doctor_id AS id, full_name AS name FROM doctors WHERE clinic_id = $1 ORDER BY full_name', [clinic_id]
        );

        // Fetch confirmed appointments
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
        res.status(500).json({ message: err.message || 'Server Error' });
    }
});


app.get('/api/doctor-work-schedule/:doctor_id', authMiddleware, async (req, res) => {
    const { doctor_id } = req.params;
    try {
        const nameResult = await db.query('SELECT full_name FROM doctors WHERE doctor_id = $1', [doctor_id]);
        if (nameResult.rows.length === 0) return res.status(404).json({ message: 'Doctor not found.' });
        const doctorName = nameResult.rows[0].full_name;
        
        const doctorRecords = await db.query('SELECT d.doctor_id, d.clinic_id, c.name as clinic_name FROM doctors d JOIN clinics c ON d.clinic_id = c.clinic_id WHERE d.full_name = $1', [doctorName]);
        const allDoctorIds = doctorRecords.rows.map(r => r.doctor_id);

        const availabilityResult = await db.query('SELECT doctor_id, day_of_week, start_time, end_time FROM doctor_availability WHERE doctor_id = ANY($1::int[])', [allDoctorIds]);
        const rulesResult = await db.query('SELECT doctor_id, day_of_week, weeks_of_month, start_time, end_time FROM doctor_availability_rules WHERE doctor_id = ANY($1::int[])', [allDoctorIds]);
        const specialSchedulesResult = await db.query('SELECT doctor_id, schedule_date, is_available FROM special_schedules WHERE doctor_id = ANY($1::int[])', [allDoctorIds]);

        const scheduleMap = new Map();
        const startDate = new Date();
        const endDate = addMonths(startDate, 2); 

        eachDayOfInterval({ start: startDate, end: endDate }).forEach(day => {
            const dayOfWeek = getDay(day);
            const dateString = format(day, 'yyyy-MM-dd');
            const weekOfMonth = getWeekOfMonth(day);
            let isWorking = false;
            let schedule = {};

            // 1. Check for weekly availability
            const weeklyAvail = availabilityResult.rows.find(a => a.day_of_week === dayOfWeek && doctorRecords.some(d => d.doctor_id === a.doctor_id));
            if (weeklyAvail) {
                isWorking = true;
                const docInfo = doctorRecords.find(d => d.doctor_id === weeklyAvail.doctor_id);
                schedule = { startTime: weeklyAvail.start_time, endTime: weeklyAvail.end_time, clinicId: docInfo.clinic_id, clinicName: docInfo.clinic_name };
            }

            // 2. Check for recurring rule (overrides weekly)
            const rule = rulesResult.rows.find(r => r.day_of_week === dayOfWeek && r.weeks_of_month.includes(weekOfMonth));
             if (rule) {
                isWorking = true;
                const docInfo = doctorRecords.find(d => d.doctor_id === rule.doctor_id);
                schedule = { startTime: rule.start_time, endTime: rule.end_time, clinicId: docInfo.clinic_id, clinicName: docInfo.clinic_name };
            }
            
            // 3. Check for specific day off (overrides all)
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

// ***************************************************************
// ** CORRECTED: Added clinic_name to the query **
// ***************************************************************
app.get('/api/doctor-availability/:doctor_id', authMiddleware, async (req, res) => {
    const { doctor_id } = req.params;
    try {
        const { rows } = await db.query(
            `SELECT da.id, da.day_of_week, da.start_time, da.end_time, d.clinic_id, c.name as clinic_name
             FROM doctor_availability da 
             JOIN doctors d ON da.doctor_id = d.doctor_id
             JOIN clinics c ON d.clinic_id = c.clinic_id
             WHERE d.full_name = (SELECT full_name FROM doctors WHERE doctor_id = $1)`,
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
    const { availability } = req.body;
    const client = await db.pool.connect();
    try {
        const { rows: nameResult } = await client.query('SELECT full_name FROM doctors WHERE doctor_id = $1', [doctor_id]);
        if (nameResult.length === 0) return res.status(404).send({ message: 'Doctor not found.' });
        
        const doctorName = nameResult[0].full_name;
        const { rows: doctorRecords } = await client.query('SELECT doctor_id, clinic_id FROM doctors WHERE full_name = $1', [doctorName]);
        
        await client.query('BEGIN');
        // This is a simplified add - it doesn't clear old schedules.
        // For a full "save" functionality, we would delete existing rows first.
        for (const slot of availability) {
            const correspondingDoctor = doctorRecords.find(rec => rec.clinic_id === slot.clinic_id);
            if (correspondingDoctor) {
                await client.query(
                    'INSERT INTO doctor_availability (doctor_id, day_of_week, start_time, end_time) VALUES ($1, $2, $3, $4)',
                    [correspondingDoctor.doctor_id, slot.day_of_week, slot.start_time, slot.end_time]
                );
            }
        }
        
        await client.query('COMMIT');
        res.status(201).send({ message: 'Availability updated successfully' });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Error saving availability:", err.message);
        res.status(500).send('Server Error');
    } finally {
        client.release();
    }
});


app.get('/api/doctor-rules/:doctor_id', authMiddleware, async(req, res) => {
    const { doctor_id } = req.params;
     try {
        const { rows } = await db.query(
            `SELECT r.id, r.day_of_week, r.weeks_of_month, r.start_time, r.end_time, r.clinic_id, c.name as clinic_name
             FROM doctor_availability_rules r
             JOIN clinics c ON r.clinic_id = c.clinic_id
             WHERE r.doctor_id IN (SELECT doctor_id FROM doctors WHERE full_name = (SELECT full_name FROM doctors WHERE doctor_id = $1))`,
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
        const { rows: nameResult } = await db.query('SELECT full_name FROM doctors WHERE doctor_id = $1', [doctor_id]);
        if (nameResult.length === 0) return res.status(404).json({ message: 'Doctor not found.' });
        const doctorName = nameResult[0].full_name;

        const { rows: specificDoctorResult } = await db.query('SELECT doctor_id FROM doctors WHERE full_name = $1 AND clinic_id = $2', [doctorName, clinic_id]);
        if (specificDoctorResult.length === 0) return res.status(400).json({ message: 'Doctor is not assigned to this clinic.'});
        
        const specificDoctorId = specificDoctorResult[0].doctor_id;

        await db.query(
            'INSERT INTO doctor_availability_rules (doctor_id, clinic_id, day_of_week, weeks_of_month, start_time, end_time) VALUES ($1, $2, $3, $4, $5, $6)',
            [specificDoctorId, clinic_id, day_of_week, weeks_of_month, start_time, end_time]
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
                   d.full_name AS doctor_name 
            FROM appointments a JOIN doctors d ON a.doctor_id = d.doctor_id 
            LEFT JOIN customers c ON a.customer_id = c.customer_id 
            WHERE a.clinic_id = $1 AND LOWER(a.status) = 'pending_confirmation'
        `, [clinic_id]);
        res.json(rows);
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ message: err.message || 'Server Error' });
    }
});

app.get('/api/confirmed-appointments', authMiddleware, async (req, res) => {
    const { clinic_id, startDate, endDate } = req.query;
    try {
        const { rows } = await db.query(`
            SELECT a.appointment_id as id, TO_CHAR(a.appointment_time, 'YYYY-MM-DD') AS appointment_date,
                   TO_CHAR(a.appointment_time, 'HH24:MI:SS') as booking_time, a.status,
                   COALESCE(a.patient_name_at_booking, c.display_name, 'Unknown Patient') as patient_name,
                   COALESCE(a.patient_phone_at_booking, c.phone_number, 'N/A') as phone_number,
                   d.full_name as doctor_name
            FROM appointments a JOIN doctors d ON a.doctor_id = d.doctor_id
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
            WHERE ss.doctor_id IN (SELECT d2.doctor_id FROM doctors d2 WHERE d2.full_name = (SELECT d3.full_name FROM doctors d3 WHERE d3.doctor_id = $1))
              AND ss.is_available = false
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

    const client = await db.pool.connect();
    try {
        const nameResult = await client.query('SELECT full_name FROM doctors WHERE doctor_id = $1', [doctor_id]);
        if (nameResult.rows.length === 0) return res.status(404).send({ message: 'Doctor not found.' });
        
        const doctorName = nameResult.rows[0].full_name;
        const specificDoctorIdResult = await client.query('SELECT doctor_id FROM doctors WHERE full_name = $1 AND clinic_id = $2', [doctorName, clinic_id]);
        if (specificDoctorIdResult.rows.length === 0) return res.status(404).send({ message: 'Doctor is not assigned to this clinic.' });
        const specificDoctorId = specificDoctorIdResult.rows[0].doctor_id;

        await client.query(
            `INSERT INTO special_schedules (doctor_id, clinic_id, schedule_date, is_available)
             VALUES ($1, $2, $3, $4) ON CONFLICT (doctor_id, schedule_date) DO UPDATE SET is_available = EXCLUDED.is_available`,
            [specificDoctorId, clinic_id, schedule_date, is_available]
        );
        
        res.status(201).json({ message: 'Special schedule created successfully.' });

    } catch (err) {
        console.error("Error in POST /api/special-schedules:", err.message);
        res.status(500).json({ message: 'Server Error' });
    } finally {
        client.release();
    }
});


app.delete('/api/special-schedules/:id', authMiddleware, async (req, res) => {
    const { id } = req.params;
    try {
        const result = await db.query('DELETE FROM special_schedules WHERE id = $1 RETURNING id', [id]);
        if (result.rowCount === 0) return res.status(404).json({ message: 'Schedule not found.' });
        res.status(200).json({ message: 'Special schedule deleted successfully.' });
    } catch (err) {
        console.error("Error deleting special schedule:", err.message);
        res.status(500).json({ message: 'Server Error' });
    }
});

app.listen(port, () => {
    console.log(`✅ Server started on port ${port}`);
});