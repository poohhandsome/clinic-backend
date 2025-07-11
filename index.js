/* -------------------------------------------------- */
/* FILE: index.js (Main Server)                       */
/* -------------------------------------------------- */
// This version includes a timezone-safe fix for the
// 'confirmed-appointments' endpoint.

const express = require('express');
const cors = require('cors');
const db = require('./db'); // Assumes db.js is in the same folder

const app = express();
const port = 3001;

app.use(cors());
app.use(express.json());

// --- API ENDPOINTS ---

// GET all clinics
app.get('/api/clinics', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT clinic_id as id, name FROM clinics ORDER BY name');
    res.json(rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server error');
  }
});

// GET all data for the DAILY view
app.get('/api/clinic-day-schedule', async (req, res) => {
    const { clinic_id, date } = req.query;
    if (!clinic_id || !date) {
        return res.status(400).json({ msg: 'Clinic ID and date are required' });
    }

    try {
        const doctorsResult = await db.query(
            'SELECT doctor_id as id, full_name as name, specialty FROM doctors WHERE clinic_id = $1 ORDER BY full_name',
            [clinic_id]
        );

        const appointmentsResult = await db.query(
            `SELECT 
                appointment_id as id, 
                doctor_id, 
                customer_id as patient_id, 
                to_char(appointment_time, 'HH24:MI:SS') as appointment_time,
                status 
             FROM appointments 
             WHERE clinic_id = $1 AND appointment_time >= $2::date AND appointment_time < ($2::date + '1 day'::interval) AND status != 'cancelled'`,
            [clinic_id, date]
        );

        res.json({
            doctors: doctorsResult.rows,
            appointments: appointmentsResult.rows,
        });

    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// GET all pending appointments for a clinic
app.get('/api/pending-appointments', async (req, res) => {
    const { clinic_id } = req.query;
    if (!clinic_id) {
        return res.status(400).json({ msg: 'Clinic ID is required' });
    }
    try {
        const { rows } = await db.query(
            `SELECT 
                a.appointment_id as id, 
                a.appointment_time::date as appointment_date, 
                to_char(a.appointment_time, 'HH24:MI:SS') as appointment_time, 
                p.display_name as patient_name, 
                d.full_name as doctor_name
             FROM appointments a
             JOIN doctors d ON a.doctor_id = d.doctor_id
             JOIN customers p ON a.customer_id = p.customer_id
             WHERE a.clinic_id = $1 AND a.status = 'pending_confirmation'`,
            [clinic_id]
        );
        res.json(rows);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// GET all confirmed appointments for a clinic on a specific date
app.get('/api/confirmed-appointments', async (req, res) => {
    const { clinic_id, date } = req.query;
    if (!clinic_id || !date) {
        return res.status(400).json({ msg: 'Clinic ID and date are required' });
    }
    try {
        // **THE FIX IS HERE**: Using a 24-hour range query which is safer for timezones.
        const { rows } = await db.query(
            `SELECT 
                a.appointment_id as id, 
                to_char(a.appointment_time, 'HH24:MI:SS') as booking_time,
                a.status,
                p.display_name as patient_name, 
                p.phone_number,
                d.full_name as doctor_name
             FROM appointments a
             JOIN doctors d ON a.doctor_id = d.doctor_id
             JOIN customers p ON a.customer_id = p.customer_id
             WHERE a.clinic_id = $1 AND a.status = 'confirmed' AND a.appointment_time >= $2::date AND a.appointment_time < ($2::date + '1 day'::interval)
             ORDER BY a.appointment_time`,
            [clinic_id, date]
        );
        res.json(rows);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// UPDATE an appointment's status (e.g., to 'confirmed')
app.patch('/api/appointments/:id', async (req, res) => {
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


// GET a doctor's availability schedule
app.get('/api/doctor-availability/:doctor_id', async (req, res) => {
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

// POST (save) a doctor's full weekly availability
app.post('/api/doctor-availability/:doctor_id', async (req, res) => {
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

// POST (create) a new appointment
app.post('/api/appointments', async (req, res) => {
  const { patient_id, doctor_id, clinic_id, appointment_date, appointment_time, status } = req.body;
  if (!patient_id || !doctor_id || !clinic_id || !appointment_date || !appointment_time) {
      return res.status(400).json({ msg: 'Missing required appointment details.' });
  }
  try {
    const appointmentTimestamp = `${appointment_date} ${appointment_time}`;
    
    const { rows } = await db.query(
      'INSERT INTO appointments (customer_id, doctor_id, clinic_id, appointment_time, status) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [patient_id, doctor_id, clinic_id, appointmentTimestamp, status || 'confirmed']
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server error');
  }
});

app.listen(port, () => {
  console.log(`Backend server running on http://localhost:${port}`);
});
