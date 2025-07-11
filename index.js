
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
    const { rows } = await db.query('SELECT * FROM clinic_list ORDER BY name');
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
        const doctorsResult = await db.query(
            'SELECT id, name, speciality FROM doctors WHERE clinic_id = $1 ORDER BY name',
            [clinic_id]
        );

        // 2. Get all appointments for that clinic on the given date
        const appointmentsResult = await db.query(
            `SELECT id, doctor_id, patient_id, appointment_date, appointment_time, status 
             FROM appointment_list 
             WHERE clinic_id = $1 AND appointment_date = $2 AND status != 'cancelled'`,
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
        // We join with doctors and patients table to get their names
        const { rows } = await db.query(
            `SELECT a.id, a.appointment_date, a.appointment_time, p.name as patient_name, d.name as doctor_name
             FROM appointment_list a
             JOIN doctors d ON a.doctor_id = d.id
             JOIN patient_list p ON a.patient_id = p.id
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
        const { rows } = await db.query(
            'UPDATE appointment_list SET status = $1 WHERE id = $2 RETURNING *',
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
    const { availability } = req.body; // Expects an array of { day_of_week, start_time, end_time }

    const client = await db.pool.connect(); // Use a transaction
    try {
        await client.query('BEGIN');
        // First, delete all old availability for this doctor
        await client.query('DELETE FROM doctor_availability WHERE doctor_id = $1', [doctor_id]);
        // Then, insert all the new availability slots
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
    const { rows } = await db.query(
      'INSERT INTO appointment_list (patient_id, doctor_id, clinic_id, appointment_date, appointment_time, status) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [patient_id, doctor_id, clinic_id, appointment_date, appointment_time, status || 'confirmed']
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
