require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
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
        console.error(err.message);
        res.status(500).json({ message: err.message || 'Server error' });
    }
});

// ***************************************************************
// ** REINSTATED AND CORRECTED: Get unique doctors and all their clinics **
// ***************************************************************
app.get('/api/doctors/unique', authMiddleware, async (req, res) => {
    try {
        const query = `
            SELECT
                d.full_name AS name,
                MIN(d.doctor_id) AS id, -- Use an aggregate to get one ID for the group
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


// This endpoint gets all doctor records for a specific clinic (for the dashboard)
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


// This endpoint gets the schedule, which is now simple and does NOT involve special schedules.
app.get('/api/clinic-day-schedule', authMiddleware, async (req, res) => {
    const { clinic_id, date } = req.query;

    if (!clinic_id || !date) {
        return res.status(400).json({ msg: 'Clinic ID and date are required' });
    }

    try {
        const dayOfWeek = new Date(date).getDay(); // 0 (Sunday) to 6 (Saturday)

        // All doctors at the clinic
        const allDoctorsResult = await db.query(
            `SELECT doctor_id AS id, full_name AS name
             FROM doctors
             WHERE clinic_id = $1
             ORDER BY full_name`,
            [clinic_id]
        );

        // Doctors working that day at the clinic
        const workingDoctorsResult = await db.query(
            `SELECT d.doctor_id AS id, d.full_name AS name, d.specialty,
                    da.start_time, da.end_time
             FROM doctors d
             JOIN doctor_availability da ON d.doctor_id = da.doctor_id
             WHERE d.clinic_id = $1 AND da.day_of_week = $2
             ORDER BY d.full_name`,
            [clinic_id, dayOfWeek]
        );

        // Appointments on the given date
        const appointmentsResult = await db.query(
            `SELECT a.appointment_id AS id,
                    a.doctor_id,
                    a.customer_id,
                    TO_CHAR(a.appointment_time, 'HH24:MI') AS appointment_time,
                    TO_CHAR(a.appointment_time + INTERVAL '30 minutes', 'HH24:MI') AS end_time,
                    a.status,
                    COALESCE(a.patient_name_at_booking, c.display_name, 'Unknown') AS patient_name_at_booking
             FROM appointments a
             LEFT JOIN customers c ON a.customer_id = c.customer_id
             WHERE a.clinic_id = $1
               AND DATE(a.appointment_time) = $2
               AND LOWER(a.status) = 'confirmed'`,
            [clinic_id, date]
        );

        res.json({
            doctors: workingDoctorsResult.rows,
            all_doctors_in_clinic: allDoctorsResult.rows,
            appointments: appointmentsResult.rows,
        });

    } catch (err) {
        console.error("Error in /api/clinic-day-schedule:", err.message);
        res.status(500).json({ message: err.message || 'Server Error' });
    }
});


// This endpoint correctly fetches the simple weekly schedule for a doctor.
app.get('/api/doctor-availability/:doctor_id', authMiddleware, async (req, res) => {
    const { doctor_id } = req.params;
    try {
        // We use a representative doctor_id since the weekly schedule is the same for a doctor across all clinics.
        const representativeIdResult = await db.query('SELECT doctor_id FROM doctors WHERE full_name = (SELECT full_name FROM doctors WHERE doctor_id = $1) LIMIT 1', [doctor_id]);
        if (representativeIdResult.rows.length === 0) {
            return res.json([]);
        }
        const representativeId = representativeIdResult.rows[0].doctor_id;

        const { rows } = await db.query(
            'SELECT day_of_week, start_time, end_time, clinic_id FROM doctor_availability WHERE doctor_id = $1',
            [representativeId]
        );
        res.json(rows);
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ message: err.message || 'Server Error' });
    }
});

// This endpoint correctly saves the simple weekly schedule for all of a doctor's records.
app.post('/api/doctor-availability/:doctor_id', authMiddleware, async (req, res) => {
    const { doctor_id } = req.params; // This is the representative ID from the dropdown
    const { availability } = req.body;
    const client = await db.pool.connect();
    try {
        // First, find all doctor_ids associated with this doctor's full_name
        const allDoctorIdsResult = await client.query('SELECT doctor_id FROM doctors WHERE full_name = (SELECT full_name FROM doctors WHERE doctor_id = $1)', [doctor_id]);
        const allDoctorIds = allDoctorIdsResult.rows.map(r => r.doctor_id);

        await client.query('BEGIN');
        
        // Delete all existing schedules for this doctor name
        await client.query('DELETE FROM doctor_availability WHERE doctor_id = ANY($1::int[])', [allDoctorIds]);

        // Insert the new schedule for just ONE of the doctor's IDs.
        const representativeId = allDoctorIds[0];
        for (const slot of availability) {
            if (slot.start_time && slot.end_time) {
                 await client.query(
                     'INSERT INTO doctor_availability (doctor_id, day_of_week, start_time, end_time, clinic_id) VALUES ($1, $2, $3, $4, $5)',
                     [representativeId, slot.day_of_week, slot.start_time, slot.end_time, slot.clinic_id]
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

// --- Other Endpoints (Unchanged) ---
app.get('/api/pending-appointments', authMiddleware, async (req, res) => {
    const { clinic_id } = req.query;
    try {
        const { rows } = await db.query(`
            SELECT 
                a.appointment_id AS id, 
                TO_CHAR(a.appointment_time, 'YYYY-MM-DD') AS appointment_date,
                TO_CHAR(a.appointment_time, 'HH24:MI:SS') AS appointment_time, 
                COALESCE(a.patient_name_at_booking, c.display_name, 'Unknown Patient') AS patient_name, 
                d.full_name AS doctor_name 
            FROM appointments a 
            JOIN doctors d ON a.doctor_id = d.doctor_id 
            LEFT JOIN customers c ON a.customer_id = c.customer_id 
            WHERE a.clinic_id = $1 
              AND LOWER(a.status) = 'pending_confirmation'
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
            SELECT 
                a.appointment_id as id,
                TO_CHAR(a.appointment_time, 'YYYY-MM-DD') AS appointment_date,
                TO_CHAR(a.appointment_time, 'HH24:MI:SS') as booking_time,
                a.status,
                COALESCE(a.patient_name_at_booking, c.display_name, 'Unknown Patient') as patient_name,
                COALESCE(a.patient_phone_at_booking, c.phone_number, 'N/A') as phone_number,
                d.full_name as doctor_name
            FROM appointments a
            JOIN doctors d ON a.doctor_id = d.doctor_id
            LEFT JOIN customers c ON a.customer_id = c.customer_id
            WHERE a.clinic_id = $1
              AND LOWER(a.status) = 'confirmed'
              AND DATE(a.appointment_time) BETWEEN $2 AND $3
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
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING *`,
            [customer_id, doctor_id, clinic_id, appointmentTimestamp, status || 'confirmed', customerName, customerPhone]
        );
        res.status(201).json(rows[0]);
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ message: err.message || 'Server Error' });
    }
});

app.listen(port, () => {
    console.log(`✅ Server started on port ${port}`);
});