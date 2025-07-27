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
app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;
    try {
        const salt = await bcrypt.genSalt(10);
        const passwordHash = await bcrypt.hash(password, salt);
        const { rows } = await db.query('INSERT INTO workers (username, password_hash) VALUES ($1, $2) RETURNING id, username', [username, passwordHash]);
        res.status(201).json({ user: rows[0] });
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ message: err.message || 'Server Error' });
    }
});

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
        res.status(500).json({ message: err.message || 'Server Error' });
    }
});

// ***************************************************************
// ** CORRECTED ENDPOINT #1: Get unique doctors               **
// ** This now gets clinic associations from existing schedules **
// ***************************************************************
app.get('/api/doctors/unique', authMiddleware, async (req, res) => {
    try {
        const query = `
            WITH DoctorClinicPairs AS (
                SELECT DISTINCT doctor_id, clinic_id FROM doctor_availability
                UNION
                SELECT DISTINCT doctor_id, clinic_id FROM special_schedules WHERE is_available = TRUE
            )
            SELECT
                d.doctor_id AS id,
                d.full_name AS name,
                json_agg(DISTINCT jsonb_build_object('id', c.clinic_id, 'name', c.name)) as clinics
            FROM doctors d
            JOIN DoctorClinicPairs dcp ON d.doctor_id = dcp.doctor_id
            JOIN clinics c ON dcp.clinic_id = c.clinic_id
            GROUP BY d.doctor_id, d.full_name
            ORDER BY d.full_name;
        `;
        const { rows } = await db.query(query);
        res.json(rows);
    } catch (err) {
        console.error("Error in /api/doctors/unique:", err.message);
        res.status(500).json({ message: err.message || 'Server Error' });
    }
});

// *****************************************************************
// ** CORRECTED: To match your confirmed database schema **
// *****************************************************************
app.get('/api/clinic-day-schedule', authMiddleware, async (req, res) => {
    const { clinic_id, date } = req.query;
    if (!clinic_id || !date) return res.status(400).json({ msg: 'Clinic ID and date are required' });

    try {
        const dayOfWeek = new Date(date).getDay();

        const allDoctorsInClinicQuery = `
            SELECT DISTINCT d.doctor_id as id, d.full_name as name, d.specialty
            FROM doctors d
            WHERE d.doctor_id IN (
                SELECT doctor_id FROM doctor_availability WHERE clinic_id = $1
                UNION
                SELECT doctor_id FROM special_schedules WHERE clinic_id = $1
            )
            ORDER BY d.full_name
        `;
        
        const workingDoctorsQuery = `
            WITH working_schedules AS (
                -- Regular schedule for today, NOT overridden by an unavailable special schedule
                SELECT da.doctor_id, da.start_time, da.end_time
                FROM doctor_availability da
                WHERE da.clinic_id = $1 AND da.day_of_week = $2
                  AND NOT EXISTS (
                    SELECT 1 FROM special_schedules ss
                    WHERE ss.doctor_id = da.doctor_id AND ss.schedule_date = $3 AND ss.is_available = FALSE
                  )
                UNION
                -- Special schedule for today that is explicitly available
                SELECT ss.doctor_id, ss.start_time, ss.end_time
                FROM special_schedules ss
                WHERE ss.clinic_id = $1 AND ss.schedule_date = $3 AND ss.is_available = TRUE
            )
            SELECT
                d.doctor_id as id,
                d.full_name as name,
                d.specialty,
                ws.start_time,
                ws.end_time
            FROM doctors d
            JOIN working_schedules ws ON d.doctor_id = ws.doctor_id
            ORDER BY d.full_name;
        `;

        const appointmentsQuery = `
            SELECT 
                a.appointment_id as id, 
                a.doctor_id, 
                a.patient_id,
                to_char(a.appointment_time, 'HH24:MI') as appointment_time, 
                to_char(a.appointment_time + interval '30 minutes', 'HH24:MI') as end_time, 
                a.status, 
                COALESCE(a.patient_name_at_booking, p.name) as patient_name_at_booking
            FROM appointments a 
            LEFT JOIN patients p ON a.patient_id = p.patient_id
            WHERE a.clinic_id = $1 
              AND a.appointment_date = $2
              AND a.status = 'confirmed'
        `;

        const [allDoctorsResult, workingDoctorsResult, appointmentsResult] = await Promise.all([
             db.query(allDoctorsInClinicQuery, [clinic_id]),
             db.query(workingDoctorsQuery, [clinic_id, dayOfWeek, date]),
             db.query(appointmentsQuery, [clinic_id, date])
        ]);
        
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


app.get('/api/removable-schedules/:doctor_id', authMiddleware, async (req, res) => {
    const { doctor_id } = req.params;
    try {
        const { rows } = await db.query(`
            SELECT
                ss.schedule_date,
                TO_CHAR(ss.schedule_date, 'Day, DD TMMonth YYYY') || ' (' || c.name || ')' as display_text
            FROM special_schedules ss
            JOIN clinics c ON ss.clinic_id = c.clinic_id
            WHERE ss.doctor_id = $1 AND ss.schedule_date >= CURRENT_DATE AND ss.is_available = TRUE
            ORDER BY ss.schedule_date;
        `, [doctor_id]);
        res.json(rows);
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ message: err.message || 'Server Error' });
    }
});

app.post('/api/special-schedules', authMiddleware, async (req, res) => {
    const { doctor_id, clinic_id, schedule_date, start_time, end_time, is_available } = req.body;
    try {
        const { rows } = await db.query(`
            INSERT INTO special_schedules (doctor_id, clinic_id, schedule_date, start_time, end_time, is_available)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (doctor_id, schedule_date) DO UPDATE SET start_time = EXCLUDED.start_time, end_time = EXCLUDED.end_time, is_available = EXCLUDED.is_available, clinic_id = EXCLUDED.clinic_id
            RETURNING *;
        `, [doctor_id, clinic_id, schedule_date, start_time, end_time, is_available]);
        res.status(201).json(rows[0]);
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ message: err.message || 'Server Error' });
    }
});

app.get('/api/pending-appointments', authMiddleware, async (req, res) => {
    const { clinic_id } = req.query;
    try {
        const { rows } = await db.query(`SELECT a.appointment_id as id, a.appointment_date, to_char(a.appointment_time, 'HH24:MI:SS') as appointment_time, COALESCE(a.patient_name_at_booking, p.name, 'Unknown Patient') as patient_name, d.full_name as doctor_name FROM appointments a JOIN doctors d ON a.doctor_id = d.doctor_id LEFT JOIN patients p on a.patient_id = p.patient_id WHERE a.clinic_id = $1 AND a.status = 'pending_confirmation'`, [clinic_id]);
        res.json(rows);
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ message: err.message || 'Server Error' });
    }
});

app.get('/api/confirmed-appointments', authMiddleware, async (req, res) => {
    const { clinic_id, startDate, endDate } = req.query;
    try {
        const { rows } = await db.query(`SELECT a.appointment_id as id, a.appointment_date, to_char(a.appointment_time, 'HH24:MI:SS') as booking_time, a.status, COALESCE(a.patient_name_at_booking, p.name, 'Unknown Patient') as patient_name, COALESCE(a.patient_phone_at_booking, p.phone_number, 'N/A') as phone_number, d.full_name as doctor_name FROM appointments a JOIN doctors d ON a.doctor_id = d.doctor_id LEFT JOIN patients p ON a.patient_id = p.patient_id WHERE a.clinic_id = $1 AND a.status = 'confirmed' AND a.appointment_date BETWEEN $2 AND $3 ORDER BY a.appointment_time`, [clinic_id, startDate, endDate]);
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
        const { rows } = await db.query(
            'UPDATE appointments SET status = $1 WHERE appointment_id = $2 RETURNING *',
            [status, id]
        );
        res.json(rows[0]);
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ message: err.message || 'Server Error' });
    }
});

app.get('/api/doctor-availability/:doctor_id', authMiddleware, async (req, res) => {
    const { doctor_id } = req.params;
    try {
        const { rows } = await db.query(
            'SELECT day_of_week, start_time, end_time, clinic_id FROM doctor_availability WHERE doctor_id = $1',
            [doctor_id]
        );
        res.json(rows);
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ message: err.message || 'Server Error' });
    }
});

app.post('/api/doctor-availability/:doctor_id', authMiddleware, async (req, res) => {
    const { doctor_id } = req.params;
    const { availability } = req.body;
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('DELETE FROM doctor_availability WHERE doctor_id = $1', [doctor_id]);
        for (const slot of availability) {
            if (slot.start_time && slot.end_time && slot.clinic_id) {
                 await client.query(
                     'INSERT INTO doctor_availability (doctor_id, day_of_week, start_time, end_time, clinic_id) VALUES ($1, $2, $3, $4, $5)',
                     [doctor_id, slot.day_of_week, slot.start_time, slot.end_time, slot.clinic_id]
                 );
            }
        }
        await client.query('COMMIT');
        res.status(201).send({ message: 'Availability updated successfully' });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err.message);
        res.status(500).send('Server Error');
    } finally {
        client.release();
    }
});

app.post('/api/appointments', authMiddleware, async (req, res) => {
    const { patient_id, doctor_id, clinic_id, appointment_date, appointment_time, status } = req.body;
    if (!patient_id || !doctor_id || !clinic_id || !appointment_date || !appointment_time) {
        return res.status(400).json({ msg: 'Missing required appointment details.' });
    }
    try {
        const appointmentTimestamp = `${appointment_date} ${appointment_time}`;
        const { rows: patientRows } = await db.query('SELECT name, phone_number FROM patients WHERE patient_id = $1', [patient_id]);
        const patientName = patientRows.length > 0 ? patientRows[0].name : 'N/A';
        const patientPhone = patientRows.length > 0 ? patientRows[0].phone_number : 'N/A';

        const { rows } = await db.query(
            'INSERT INTO appointments (patient_id, doctor_id, clinic_id, appointment_date, appointment_time, status, patient_name_at_booking, patient_phone_at_booking) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *',
            [patient_id, doctor_id, clinic_id, appointment_date, appointmentTimestamp, status || 'confirmed', patientName, patientPhone]
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