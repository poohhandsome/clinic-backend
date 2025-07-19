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
        res.status(500).json({ msg: 'Server error, username may already exist.' });
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
        res.status(500).send('Server Error');
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

// Health check endpoint (retained as requested)
app.get('/api/health', (req, res) => res.status(200).json({ status: 'ok' }));

app.get('/api/clinics', authMiddleware, async (req, res) => {
    try {
        const { rows } = await db.query('SELECT clinic_id as id, name FROM clinics ORDER BY name');
        res.json(rows);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server error');
    }
});

// MODIFIED: This endpoint now checks for special schedule overrides
app.get('/api/clinic-day-schedule', authMiddleware, async (req, res) => {
    const { clinic_id, date } = req.query;
    if (!clinic_id || !date) return res.status(400).json({ msg: 'Clinic ID and date are required' });
    try {
        const allDoctorsResult = await db.query('SELECT doctor_id as id, full_name as name, specialty FROM doctors WHERE clinic_id = $1 ORDER BY full_name', [clinic_id]);
        const dayOfWeek = new Date(date).getDay();
        const workingDoctorsResult = await db.query(`
            WITH regular_schedule AS (
                SELECT d.doctor_id, d.full_name, d.specialty, da.start_time, da.end_time
                FROM doctors d
                JOIN doctor_availability da ON d.doctor_id = da.doctor_id
                WHERE d.clinic_id = $1 AND da.day_of_week = $2
            ),
            special_schedule AS (
                SELECT doctor_id, start_time, end_time, is_available
                FROM special_schedules
                WHERE clinic_id = $1 AND schedule_date = $3
            )
            SELECT
                d.doctor_id as id, d.full_name as name, d.specialty,
                COALESCE(ss.start_time, rs.start_time) as start_time,
                COALESCE(ss.end_time, rs.end_time) as end_time
            FROM doctors d
            LEFT JOIN regular_schedule rs ON d.doctor_id = rs.doctor_id
            LEFT JOIN special_schedule ss ON d.doctor_id = ss.doctor_id
            WHERE
                d.clinic_id = $1
                AND (
                    (ss.is_available = TRUE)
                    OR (rs.doctor_id IS NOT NULL AND ss.is_available IS NULL)
                )
            ORDER BY d.full_name
        `, [clinic_id, dayOfWeek, date]);
        const appointmentsResult = await db.query(`SELECT a.appointment_id as id, a.doctor_id, a.customer_id as patient_id, to_char(a.appointment_time, 'HH24:MI') as appointment_time, a.status, COALESCE(a.patient_name_at_booking, c.display_name) as patient_name_at_booking FROM appointments a LEFT JOIN customers c ON a.customer_id = c.customer_id WHERE a.clinic_id = $1 AND a.appointment_time >= $2::date AND a.appointment_time < ($2::date + '1 day'::interval) AND a.status != 'cancelled'`, [clinic_id, date]);
        res.json({
            doctors: workingDoctorsResult.rows,
            all_doctors_in_clinic: allDoctorsResult.rows,
            appointments: appointmentsResult.rows,
        });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// NEW: Endpoint to get a list of a doctor's upcoming scheduled work days
app.get('/api/removable-schedules/:doctor_id', authMiddleware, async (req, res) => {
    const { doctor_id } = req.params;
    try {
        const { rows } = await db.query(`
            WITH future_dates AS (
                SELECT generate_series(CURRENT_DATE, CURRENT_DATE + interval '90 day', '1 day')::date as schedule_date
            )
            SELECT
                fd.schedule_date, to_char(fd.schedule_date, 'Day, DD TMMonth YYYY') as display_text
            FROM future_dates fd
            JOIN doctor_availability da ON EXTRACT(DOW FROM fd.schedule_date) = da.day_of_week
            WHERE da.doctor_id = $1 AND NOT EXISTS (
                SELECT 1 FROM special_schedules ss WHERE ss.doctor_id = da.doctor_id AND ss.schedule_date = fd.schedule_date AND ss.is_available = FALSE
            )
            ORDER BY fd.schedule_date LIMIT 30;
        `, [doctor_id]);
        res.json(rows);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// NEW: Endpoint to add or remove a special, date-specific schedule
app.post('/api/special-schedules', authMiddleware, async (req, res) => {
    const { doctor_id, clinic_id, schedule_date, start_time, end_time, is_available } = req.body;
    try {
        const { rows } = await db.query(`
            INSERT INTO special_schedules (doctor_id, clinic_id, schedule_date, start_time, end_time, is_available)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (doctor_id, schedule_date) DO UPDATE SET start_time = EXCLUDED.start_time, end_time = EXCLUDED.end_time, is_available = EXCLUDED.is_available
            RETURNING *;
        `, [doctor_id, clinic_id, schedule_date, start_time, end_time, is_available]);
        res.status(201).json(rows[0]);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// --- Existing Appointment and Schedule Endpoints ---
app.get('/api/pending-appointments', authMiddleware, async (req, res) => {
    const { clinic_id } = req.query;
    try {
        const { rows } = await db.query(`SELECT a.appointment_id as id, a.appointment_time::date as appointment_date, to_char(a.appointment_time, 'HH24:MI:SS') as appointment_time, COALESCE(a.patient_name_at_booking, c.display_name, 'Unknown Patient') as patient_name, d.full_name as doctor_name FROM appointments a JOIN doctors d ON a.doctor_id = d.doctor_id LEFT JOIN customers c on a.customer_id = c.customer_id WHERE a.clinic_id = $1 AND a.status = 'pending_confirmation'`, [clinic_id]);
        res.json(rows);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

app.get('/api/confirmed-appointments', authMiddleware, async (req, res) => {
    const { clinic_id, startDate, endDate } = req.query;
    try {
        const { rows } = await db.query(`SELECT a.appointment_id as id, to_char(a.appointment_time, 'YYYY-MM-DD') as appointment_date, to_char(a.appointment_time, 'HH24:MI:SS') as booking_time, a.status, COALESCE(a.patient_name_at_booking, c.display_name, 'Unknown Patient') as patient_name, COALESCE(a.patient_phone_at_booking, c.phone_number, 'N/A') as phone_number, d.full_name as doctor_name FROM appointments a JOIN doctors d ON a.doctor_id = d.doctor_id LEFT JOIN customers c ON a.customer_id = c.customer_id WHERE a.clinic_id = $1 AND a.status = 'confirmed' AND a.appointment_time >= $2::date AND a.appointment_time < ($3::date + '1 day'::interval) ORDER BY a.appointment_time`, [clinic_id, startDate, endDate]);
        res.json(rows);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
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
        res.status(500).send('Server Error');
    }
});

app.get('/api/doctor-availability/:doctor_id', authMiddleware, async (req, res) => {
    const { doctor_id } = req.params;
    try {
        const { rows } = await db.query(
            'SELECT day_of_week, start_time, end_time FROM doctor_availability WHERE doctor_id = $1',
            [doctor_id]
        );
        res.json(rows);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
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
            if (slot.start_time && slot.end_time) {
                 await client.query(
                    'INSERT INTO doctor_availability (doctor_id, day_of_week, start_time, end_time) VALUES ($1, $2, $3, $4)',
                    [doctor_id, slot.day_of_week, slot.start_time, slot.end_time]
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
    const { rows: customerRows } = await db.query('SELECT display_name, phone_number FROM customers WHERE customer_id = $1', [patient_id]);
    const patientName = customerRows.length > 0 ? customerRows[0].display_name : 'N/A';
    const patientPhone = customerRows.length > 0 ? customerRows[0].phone_number : 'N/A';

    const { rows } = await db.query(
      'INSERT INTO appointments (customer_id, doctor_id, clinic_id, appointment_time, status, patient_name_at_booking, patient_phone_at_booking) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
      [patient_id, doctor_id, clinic_id, appointmentTimestamp, status || 'confirmed', patientName, patientPhone]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

app.listen(port, () => {
  console.log(`✅ Server started on port ${port}`);
});