/* -------------------------------------------------- */
/* FILE: index.js (Main Server)                       */
/* -------------------------------------------------- */
// This version has been updated to match your exact database schema:
// - Table names: clinics, appointments, customers, doctors
// - Column names: full_name, specialty, customer_id, display_name
// - Handles a single 'appointment_time' timestamp column.

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
    // Using your 'clinics' table. Aliasing clinic_id to id for frontend compatibility.
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
        // 1. Get all doctors for the clinic
        // Corrected column names to full_name and specialty, and aliased them for the frontend.
        const doctorsResult = await db.query(
            'SELECT doctor_id as id, full_name as name, specialty FROM doctors WHERE clinic_id = $1 ORDER BY full_name',
            [clinic_id]
        );

        // 2. Get all appointments for that clinic on the given date
        // Updated to query a single timestamp column by casting it to a date.
        const appointmentsResult = await db.query(
            `SELECT 
                appointment_id as id, 
                doctor_id, 
                customer_id as patient_id, 
                appointment_time::time as appointment_time, -- Extract time part
                status 
             FROM appointments 
             WHERE clinic_id = $1 AND appointment_time::date = $2::date AND status != 'cancelled'`,
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
        // Corrected table and column names (customers, display_name, full_name)
        const { rows } = await db.query(
            `SELECT 
                a.appointment_id as id, 
                a.appointment_time::date as appointment_date, 
                a.appointment_time::time as appointment_time, 
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

// UPDATE an appointment's status (e.g., to 'confirmed')
app.patch('/api/appointments/:id', async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;
    try {
        // Using your appointment_id column
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
        // Assuming doctor_availability table exists as previously instructed
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
    // Updated to combine date and time from frontend into a single timestamp for the database
    const appointmentTimestamp = `${appointment_date} ${appointment_time}`;
    
    // Using your 'customers' table for the patient_id
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
