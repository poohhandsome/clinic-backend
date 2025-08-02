// index.js (REPLACE)

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { format, addMonths, startOfMonth, getDay, eachDayOfInterval, addDays, endOfMonth } = require('date-fns');
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
// ** MODIFIED: Get unique doctors with new fields (status, color, etc.) **
// ***************************************************************
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

// ***************************************************************
// ** MODIFIED: Create doctor with new fields **
// ***************************************************************
app.post('/api/doctors', authMiddleware, async (req, res) => {
    const { fullName, specialty, clinicIds, email, password, color, status } = req.body;

    if (!fullName || !clinicIds || !Array.isArray(clinicIds) || clinicIds.length === 0 || !email || !password) {
        return res.status(400).json({ message: 'Full name, clinic(s), email, and password are required.' });
    }

    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');

        // Hash the password
        const salt = await bcrypt.genSalt(10);
        const passwordHash = await bcrypt.hash(password, salt);

        // Create a separate row for each clinic assignment
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
        if (err.code === '23505') { // Handles unique constraint violation
            return res.status(409).json({ message: 'A doctor with this email or clinic assignment already exists.' });
        }
        res.status(500).json({ message: err.message || 'Server Error' });
    } finally {
        client.release();
    }
});

// ***************************************************************
// ** MODIFIED: Update doctor with new fields **
// ***************************************************************
app.put('/api/doctors/:id/clinics', authMiddleware, async (req, res) => {
    const { id } = req.params; // This is a representative ID
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

        // Update non-password fields on all existing records for this doctor
        await client.query(
            'UPDATE doctors SET specialty = $1, email = $2, color = $3, status = $4 WHERE full_name = $5',
            [specialty, email, color, status, fullName]
        );
        
        // If a new password is provided, hash it and update it
        if (password) {
            const salt = await bcrypt.genSalt(10);
            const passwordHash = await bcrypt.hash(password, salt);
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

app.get('/api/doctor-work-schedule/:doctor_id', authMiddleware, async (req, res) => {
    const { doctor_id } = req.params;
    try {
        const nameResult = await db.query('SELECT full_name FROM doctors WHERE doctor_id = $1', [doctor_id]);
        if (nameResult.rows.length === 0) return res.status(404).json({ message: 'Doctor not found.' });
        const doctorName = nameResult.rows[0].full_name;
        
        const doctorRecords = await db.query('SELECT d.doctor_id, d.clinic_id, d.full_name, c.name as clinic_name FROM doctors d JOIN clinics c ON d.clinic_id = c.clinic_id WHERE d.full_name = $1', [doctorName]);

        const availabilityResult = await db.query('SELECT doctor_id, day_of_week, start_time, end_time FROM doctor_availability WHERE doctor_id = ANY($1::int[])', [doctorRecords.rows.map(r => r.doctor_id)]);
        const specialSchedulesResult = await db.query('SELECT doctor_id, TO_CHAR(schedule_date, \'YYYY-MM-DD\') as schedule_date, start_time, end_time, is_available FROM special_schedules WHERE doctor_id = ANY($1::int[])', [doctorRecords.rows.map(r => r.doctor_id)]);

        const scheduleMap = new Map();
        const startDate = new Date();
        const endDate = addMonths(startDate, 2); // Look 2 months ahead

        // 1. Process weekly schedule
        eachDayOfInterval({ start: startDate, end: endDate }).forEach(day => {
            const dayOfWeek = getDay(day);
            availabilityResult.rows.forEach(avail => {
                if (avail.day_of_week === dayOfWeek) {
                    const docInfo = doctorRecords.rows.find(d => d.doctor_id === avail.doctor_id);
                    if (docInfo) {
                        scheduleMap.set(format(day, 'yyyy-MM-dd'), {
                            date: format(day, 'yyyy-MM-dd'),
                            isAvailable: true,
                            startTime: avail.start_time,
                            endTime: avail.end_time,
                            clinicId: docInfo.clinic_id,
                            clinicName: docInfo.clinic_name
                        });
                    }
                }
            });
        });

        // 2. Override with special schedules
        specialSchedulesResult.rows.forEach(special => {
            if (special.is_available) {
                const docInfo = doctorRecords.rows.find(d => d.doctor_id === special.doctor_id);
                if (docInfo) {
                    scheduleMap.set(special.schedule_date, {
                        date: special.schedule_date,
                        isAvailable: true,
                        startTime: special.start_time,
                        endTime: special.end_time,
                        clinicId: docInfo.clinic_id,
                        clinicName: docInfo.clinic_name
                    });
                }
            } else {
                scheduleMap.delete(special.schedule_date); // Day off, remove from working days
            }
        });

        const workingDays = Array.from(scheduleMap.values()).sort((a,b) => new Date(a.date) - new Date(b.date));
        res.json(workingDays);

    } catch (err) {
        console.error("Error calculating work schedule:", err.message);
        res.status(500).json({ message: 'Server Error' });
    }
});
// This endpoint correctly fetches the simple weekly schedule for a doctor.
app.get('/api/doctor-availability/:doctor_id', authMiddleware, async (req, res) => {
    const { doctor_id } = req.params;
    try {
        const query = `
            SELECT
                da.day_of_week,
                da.start_time,
                da.end_time,
                d.clinic_id
            FROM doctor_availability da
            JOIN doctors d ON da.doctor_id = d.doctor_id
            WHERE d.full_name = (SELECT full_name FROM doctors WHERE doctor_id = $1)
        `;
        const { rows } = await db.query(query, [doctor_id]);
        res.json(rows);
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ message: err.message || 'Server Error' });
    }
});

// This endpoint correctly saves the simple weekly schedule for all of a doctor's records.
app.post('/api/doctor-availability/:doctor_id', authMiddleware, async (req, res) => {
    const { doctor_id } = req.params;
    const { availability } = req.body;
    const client = await db.pool.connect();
    try {
        const nameResult = await client.query('SELECT full_name FROM doctors WHERE doctor_id = $1', [doctor_id]);
        if (nameResult.rows.length === 0) {
            return res.status(404).send({ message: 'Doctor not found.' });
        }
        const doctorName = nameResult.rows[0].full_name;

        const allDoctorRecordsResult = await client.query('SELECT doctor_id, clinic_id FROM doctors WHERE full_name = $1', [doctorName]);
        const doctorRecords = allDoctorRecordsResult.rows;
        const allDoctorIds = doctorRecords.map(r => r.doctor_id);

        await client.query('BEGIN');
        
        await client.query('DELETE FROM doctor_availability WHERE doctor_id = ANY($1::int[])', [allDoctorIds]);

        for (const slot of availability) {
            if (slot.start_time && slot.end_time && slot.clinic_id) {
                const correspondingDoctor = doctorRecords.find(rec => rec.clinic_id === slot.clinic_id);
                if (correspondingDoctor) {
                    await client.query(
                        'INSERT INTO doctor_availability (doctor_id, day_of_week, start_time, end_time) VALUES ($1, $2, $3, $4)',
                        [correspondingDoctor.doctor_id, slot.day_of_week, slot.start_time, slot.end_time]
                    );
                }
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
app.get('/api/special-schedules/:doctor_id', authMiddleware, async (req, res) => {
    const { doctor_id } = req.params;
    try {
        const query = `
            SELECT
                ss.id,
                ss.doctor_id,
                ss.clinic_id,
                c.name as clinic_name,
                TO_CHAR(ss.schedule_date, 'YYYY-MM-DD') as schedule_date,
                ss.start_time,
                ss.end_time,
                ss.is_available
            FROM special_schedules ss
            JOIN clinics c ON ss.clinic_id = c.clinic_id
            WHERE ss.doctor_id IN (
                SELECT d2.doctor_id FROM doctors d2 WHERE d2.full_name = (
                    SELECT d3.full_name FROM doctors d3 WHERE d3.doctor_id = $1
                )
            )
            ORDER BY ss.schedule_date DESC;
        `;
        const { rows } = await db.query(query, [doctor_id]);
        res.json(rows);
    } catch (err) {
        console.error("Error fetching special schedules:", err.message);
        res.status(500).json({ message: 'Server Error' });
    }
});

// Add a new special schedule
app.post('/api/special-schedules', authMiddleware, async (req, res) => {
    const { doctor_id, clinic_id, schedule_date, start_time, end_time, is_available, rule } = req.body;

    if (!doctor_id || !clinic_id) return res.status(400).json({ message: 'Doctor and clinic are required.' });

    const client = await db.pool.connect();
    try {
        const nameResult = await client.query('SELECT full_name FROM doctors WHERE doctor_id = $1', [doctor_id]);
        if (nameResult.rows.length === 0) return res.status(404).send({ message: 'Doctor not found.' });
        const doctorName = nameResult.rows[0].full_name;

        const specificDoctorIdResult = await client.query('SELECT doctor_id FROM doctors WHERE full_name = $1 AND clinic_id = $2', [doctorName, clinic_id]);
        if (specificDoctorIdResult.rows.length === 0) return res.status(404).send({ message: 'Doctor is not assigned to this clinic.' });
        const specificDoctorId = specificDoctorIdResult.rows[0].doctor_id;

        await client.query('BEGIN');
        
        // --- Logic to handle single date OR recurring rule ---
        let datesToInsert = [];
        if (rule) { // Recurring rule logic
            const { week, day } = rule;
            const year = new Date().getFullYear();
            // Create schedules for the next 12 months
            for (let month = 0; month < 12; month++) {
                const firstDayOfMonth = new Date(year, month, 1);
                let firstOccurrence = startOfMonth(firstDayOfMonth);
                while (getDay(firstOccurrence) !== day) {
                    firstOccurrence = addDays(firstOccurrence, 1);
                }
                const targetDate = addDays(firstOccurrence, (week - 1) * 7);
                if (targetDate.getMonth() === month) {
                    datesToInsert.push(format(targetDate, 'yyyy-MM-dd'));
                }
            }
        } else if (schedule_date) { // Single date logic
            datesToInsert.push(schedule_date);
        }

        if (datesToInsert.length === 0) {
            return res.status(400).json({ message: 'No valid dates found for the given rule.' });
        }

        const insertPromises = datesToInsert.map(date => {
            return client.query(
                `INSERT INTO special_schedules (doctor_id, clinic_id, schedule_date, start_time, end_time, is_available)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [specificDoctorId, clinic_id, date, start_time, end_time, is_available]
            );
        });
        
        await Promise.all(insertPromises);
        await client.query('COMMIT');
        res.status(201).json({ message: 'Special schedule(s) created successfully.' });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Error in POST /api/special-schedules:", err.message);
        res.status(500).json({ message: 'Server Error' });
    } finally {
        client.release();
    }
});

// Delete a special schedule
app.delete('/api/special-schedules/:id', authMiddleware, async (req, res) => {
    const { id } = req.params;
    try {
        const result = await db.query('DELETE FROM special_schedules WHERE id = $1 RETURNING id', [id]);
        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Schedule not found.' });
        }
        res.status(200).json({ message: 'Special schedule deleted successfully.' });
    } catch (err) {
        console.error("Error deleting special schedule:", err.message);
        res.status(500).json({ message: 'Server Error' });
    }
});
app.listen(port, () => {
    console.log(`✅ Server started on port ${port}`);
});