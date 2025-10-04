// index.js (REPLACE)

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const { format, addMonths, startOfMonth, getDay, eachDayOfInterval, addDays, endOfMonth, getWeekOfMonth } = require('date-fns');
const db = require('./db');

const app = express();
const port = process.env.PORT || 3001;

// Trust proxy - Required when behind reverse proxy (Render, Heroku, etc.)
app.set('trust proxy', 1);

// Apply security headers
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            scriptSrc: ["'self'"],
            imgSrc: ["'self'", "data:", "https:"],
        },
    },
    crossOriginEmbedderPolicy: false, // Allow embedding if needed
}));

// Configure CORS to only allow requests from your frontend domain
const corsOptions = {
    origin: process.env.FRONTEND_URL || 'http://localhost:5173',
    credentials: true,
    optionsSuccessStatus: 200,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization']
};

app.use(cors(corsOptions));
app.use(express.json());

// --- Force HTTPS in Production ---
if (process.env.NODE_ENV === 'production') {
    app.use((req, res, next) => {
        if (req.header('x-forwarded-proto') !== 'https') {
            return res.redirect(301, `https://${req.header('host')}${req.url}`);
        }
        next();
    });
}

// --- Rate Limiting Configuration ---
// Rate limiter for login attempts
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5, // Limit each IP to 5 login requests per windowMs
    standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
    legacyHeaders: false, // Disable the `X-RateLimit-*` headers
    skipSuccessfulRequests: false, // Count successful requests
    handler: (req, res) => {
        res.status(429).json({
            msg: 'Too many login attempts from this IP, please try again after 15 minutes.',
            retryAfter: Math.ceil(req.rateLimit.resetTime / 1000 / 60) + ' minutes'
        });
    }
});

// --- Authentication Routes ---
// in index.js (REPLACE THIS ENDPOINT)

app.post('/api/login', loginLimiter, async (req, res) => {
    const { username, password } = req.body;

    // Input validation
    if (!username || !password) {
        return res.status(400).json({ msg: 'Username and password are required' });
    }

    if (typeof username !== 'string' || typeof password !== 'string') {
        return res.status(400).json({ msg: 'Invalid input format' });
    }

    if (username.trim().length === 0 || password.length === 0) {
        return res.status(400).json({ msg: 'Username and password cannot be empty' });
    }

    if (username.length > 255 || password.length > 255) {
        return res.status(400).json({ msg: 'Input exceeds maximum length' });
    }

    try {
        let user = null;
        let userRole = '';

        // Step 1: Check the 'workers' table
        const workerResult = await db.query('SELECT id, username, password_hash FROM workers WHERE username = $1', [username.trim()]);
        if (workerResult.rows.length > 0) {
            user = workerResult.rows[0];
            userRole = 'nurse';
        } else {
            // Step 2: If not in 'workers', check the 'doctors_identities' table
            const doctorResult = await db.query('SELECT doctor_id AS id, email AS username, password_hash FROM doctors_identities WHERE email = $1', [username.trim()]);
            if (doctorResult.rows.length > 0) {
                user = doctorResult.rows[0];
                userRole = 'doctor';
            }
        }

        // Step 3: If user is still null, they don't exist
        if (!user) {
            return res.status(400).json({ msg: 'Invalid credentials' });
        }
        
        // Step 4: Compare the password
        const isMatch = await bcrypt.compare(password, user.password_hash);
        if (!isMatch) {
            return res.status(400).json({ msg: 'Invalid credentials' });
        }

        // Step 5: Create a token with the user's ID, username, and role
        const payload = { 
            user: { 
                id: user.id, 
                username: user.username,
                role: userRole 
            } 
        };

        jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '12h' }, (err, token) => {
            if (err) throw err;
            res.json({ token, user: payload.user });
        });

    } catch (err) {
        handleError(res, err, 'Login failed. Please try again later.');
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

// --- Role-Based Authorization Middleware ---
const checkRole = (...allowedRoles) => {
    return (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({ msg: 'Authentication required' });
        }

        if (!allowedRoles.includes(req.user.role)) {
            return res.status(403).json({
                msg: 'Access denied. You do not have permission to perform this action.',
                requiredRole: allowedRoles,
                yourRole: req.user.role
            });
        }

        next();
    };
};

// --- Centralized Error Handler ---
const handleError = (res, err, customMessage = 'Server Error') => {
    // Log full error details for debugging (only visible to developers)
    console.error('Error Details:', {
        message: err.message,
        stack: process.env.NODE_ENV !== 'production' ? err.stack : undefined,
        timestamp: new Date().toISOString()
    });

    // Send safe error message to client
    if (process.env.NODE_ENV === 'production') {
        res.status(500).json({ message: customMessage });
    } else {
        // In development, include more details for debugging
        res.status(500).json({
            message: customMessage,
            error: err.message,
            stack: err.stack
        });
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

app.post('/api/doctors', authMiddleware, checkRole('nurse', 'admin'), async (req, res) => {
    const { fullName, specialty, clinicIds, email, password, color, status } = req.body;
    if (!fullName || !clinicIds || !Array.isArray(clinicIds) || clinicIds.length === 0 || !email || !password) {
        return res.status(400).json({ message: 'Full name, clinic(s), email, and password are required.' });
    }

    // Password strength validation
    if (password.length < 8) {
        return res.status(400).json({ message: 'Password must be at least 8 characters long.' });
    }

    const hasUpperCase = /[A-Z]/.test(password);
    const hasLowerCase = /[a-z]/.test(password);
    const hasNumbers = /\d/.test(password);
    const hasSpecialChar = /[!@#$%^&*(),.?":{}|<>]/.test(password);

    if (!hasUpperCase || !hasLowerCase || !hasNumbers) {
        return res.status(400).json({
            message: 'Password must contain at least one uppercase letter, one lowercase letter, and one number.'
        });
    }

    // Email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
        return res.status(400).json({ message: 'Please provide a valid email address.' });
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

app.put('/api/doctors/:id', authMiddleware, checkRole('nurse', 'admin'), async (req, res) => {
    const { id } = req.params;
    const { clinicIds, specialty, email, color, status, password } = req.body;
    if (!Array.isArray(clinicIds)) {
        return res.status(400).json({ message: 'clinicIds must be an array.' });
    }

    // Password strength validation (only if password is being updated)
    if (password) {
        if (password.length < 8) {
            return res.status(400).json({ message: 'Password must be at least 8 characters long.' });
        }

        const hasUpperCase = /[A-Z]/.test(password);
        const hasLowerCase = /[a-z]/.test(password);
        const hasNumbers = /\d/.test(password);

        if (!hasUpperCase || !hasLowerCase || !hasNumbers) {
            return res.status(400).json({
                message: 'Password must contain at least one uppercase letter, one lowercase letter, and one number.'
            });
        }
    }

    // Email validation (if email is being updated)
    if (email) {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return res.status(400).json({ message: 'Please provide a valid email address.' });
        }
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
app.post('/api/patients', authMiddleware, checkRole('nurse', 'doctor', 'admin'), async (req, res) => {
    const {
        dn, dn_old, id_verification_type, id_number, title_th, first_name_th, last_name_th,
        title_en, first_name_en, last_name_en, nickname, gender, date_of_birth,
        chronic_diseases, allergies, mobile_phone, home_phone, line_id, email,
        address, sub_district, district, province, country, zip_code
    } = req.body;

    // Input validation
    if (!first_name_th || !last_name_th) {
        return res.status(400).json({ message: 'First name and last name (Thai) are required.' });
    }

    // Email validation (if provided)
    if (email && email.trim().length > 0) {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return res.status(400).json({ message: 'Please provide a valid email address.' });
        }
    }

    // Mobile phone validation (if provided) - basic Thai phone number format
    if (mobile_phone && mobile_phone.trim().length > 0) {
        const phoneRegex = /^[0-9]{9,10}$/;
        if (!phoneRegex.test(mobile_phone.replace(/[-\s]/g, ''))) {
            return res.status(400).json({ message: 'Please provide a valid mobile phone number (9-10 digits).' });
        }
    }

    // Gender validation
    if (gender && !['male', 'female', 'other'].includes(gender.toLowerCase())) {
        return res.status(400).json({ message: 'Gender must be male, female, or other.' });
    }

    // Date of birth validation
    if (date_of_birth) {
        const dob = new Date(date_of_birth);
        if (isNaN(dob.getTime()) || dob > new Date()) {
            return res.status(400).json({ message: 'Please provide a valid date of birth.' });
        }
    }

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
    if (!clinic_id || !date) {
        return res.status(400).json({ msg: 'Clinic ID and date are required' });
    }

    try {
        const targetDate = new Date(date);
        const dayOfWeek = getDay(targetDate);
        const weekOfMonth = getWeekOfMonth(targetDate);

        // This query for working doctors is correct
        const workingDoctorsQuery = `
            WITH working_doctors AS (
                SELECT da.doctor_id, da.start_time, da.end_time FROM doctor_availability da WHERE da.clinic_id = $1 AND da.day_of_week = $2
                UNION
                SELECT dr.doctor_id, dr.start_time, dr.end_time FROM doctor_availability_rules dr WHERE dr.clinic_id = $1 AND dr.day_of_week = $2 AND $3 = ANY(dr.weeks_of_month)
            )
            SELECT di.doctor_id AS id, di.full_name AS name, di.specialty, wd.start_time, wd.end_time
            FROM doctors_identities di
            JOIN working_doctors wd ON di.doctor_id = wd.doctor_id
            WHERE di.status = 'active' AND di.doctor_id NOT IN (
                SELECT ss.doctor_id FROM special_schedules ss WHERE ss.schedule_date = $4 AND ss.is_available = false
            );
        `;
        const { rows: finalWorkingDoctors } = await db.query(workingDoctorsQuery, [clinic_id, dayOfWeek, weekOfMonth, date]);

        const { rows: allDoctors } = await db.query(
            `SELECT di.doctor_id AS id, di.full_name AS name 
             FROM doctors_identities di
             JOIN doctor_clinic_assignments dca ON di.doctor_id = dca.doctor_id
             WHERE dca.clinic_id = $1 ORDER BY di.full_name`, [clinic_id]
        );

        // **THE CRITICAL FIX IS HERE**
        // The query now fetches all appointments EXCEPT those that are 'cancelled'.
        const { rows: appointments } = await db.query(
            `SELECT a.appointment_id AS id, a.doctor_id, a.customer_id,
                    TO_CHAR(a.appointment_time, 'HH24:MI') AS appointment_time,
                    TO_CHAR(a.end_time, 'HH24:MI') AS end_time,
                    a.status, COALESCE(a.patient_name_at_booking, p.first_name_th || ' ' || p.last_name_th, c.display_name, 'Unknown') AS patient_name_at_booking
             FROM appointments a 
             LEFT JOIN customers c ON a.customer_id = c.customer_id
             LEFT JOIN patients p ON a.patient_id = p.patient_id
             WHERE a.clinic_id = $1 AND DATE(a.appointment_time) = $2 AND LOWER(a.status) != 'cancelled'`,
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

// ***************************************************************
// ** REWRITTEN: Fetches detailed pending appointments with correct joins **
// ***************************************************************
app.get('/api/pending-appointments', authMiddleware, async (req, res) => {
    const { clinic_id } = req.query;
    try {
        const query = `
            SELECT 
                a.appointment_id AS id,
                a.doctor_id, a.clinic_id, a.customer_id, a.patient_id,
                TO_CHAR(a.appointment_time, 'YYYY-MM-DD') AS appointment_date,
                TO_CHAR(a.appointment_time, 'HH24:MI:SS') AS appointment_time,
                a.status, a.purpose, a.room_id,
                COALESCE(a.patient_name_at_booking, p.first_name_th || ' ' || p.last_name_th, c.display_name, 'Unknown') as patient_name,
                p.dn,
                p.mobile_phone,
                p.line_id,
                p.date_of_birth,
                di.full_name AS doctor_name,
                r.room_name
            FROM appointments a
            JOIN doctors_identities di ON a.doctor_id = di.doctor_id
            LEFT JOIN patients p ON a.patient_id = p.patient_id
            LEFT JOIN customers c ON a.customer_id = c.customer_id
            LEFT JOIN rooms r ON a.room_id = r.room_id
            WHERE a.clinic_id = $1 AND LOWER(a.status) = 'pending_confirmation'
            ORDER BY a.appointment_time;
        `;
        const { rows } = await db.query(query, [clinic_id]);
        res.json(rows);
    } catch (err) {
        console.error("Error fetching pending appointments:", err.message);
        res.status(500).json({ message: 'Server Error' });
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
                a.clinic_id,
                a.patient_id, -- <<< THE FIX IS HERE
                TO_CHAR(a.appointment_time, 'YYYY-MM-DD') AS appointment_date,
                TO_CHAR(a.appointment_time, 'HH24:MI:SS') as booking_time,
                a.status, a.purpose, a.room_id,
                COALESCE(a.patient_name_at_booking, c.display_name, 'Unknown Patient') as patient_name,
                di.full_name as doctor_name
            FROM appointments a
            JOIN doctors_identities di ON a.doctor_id = di.doctor_id
            LEFT JOIN customers c ON a.customer_id = c.customer_id
            WHERE a.clinic_id = $1 AND DATE(a.appointment_time) BETWEEN $2 AND $3
            ORDER BY a.appointment_time
        `, [clinic_id, startDate, endDate]);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ message: err.message || 'Server Error' });
    }
});
// ***************************************************************
// ** NEW ENDPOINT: Update any detail of an appointment **
// ***************************************************************

app.patch('/api/appointments/:id', authMiddleware, async (req, res) => {
    const { id } = req.params;
    const { status, doctor_id, appointment_date, appointment_time, purpose, room_id, confirmation_notes } = req.body;

    // Use a database transaction to ensure data integrity
    const client = await db.pool.connect();

    try {
        await client.query('BEGIN');

        // Check if the status is being set to 'Checked-in'
        if (status && status.toLowerCase() === 'checked-in') {
            // Step 1: Get the appointment details we need to create a visit
            const appointmentRes = await client.query(
                'SELECT patient_id, clinic_id, doctor_id FROM appointments WHERE appointment_id = $1',
                [id]
            );

            if (appointmentRes.rows.length === 0) {
                throw new Error('Appointment not found.');
            }

            const { patient_id, clinic_id, doctor_id: assigned_doctor_id } = appointmentRes.rows[0];

            if (!patient_id) {
                throw new Error('Cannot check-in. This appointment is not linked to a patient record.');
            }

            // Step 2: Insert a new record into the `visits` table
            // This places the patient into the live queue for the doctor
            await client.query(
                `INSERT INTO visits (patient_id, clinic_id, doctor_id, appointment_id, check_in_time, status)
                 VALUES ($1, $2, $3, $4, NOW(), 'waiting')
                 ON CONFLICT (appointment_id) DO NOTHING`, // Prevents creating duplicate visits for the same appointment
                [patient_id, clinic_id, assigned_doctor_id, id]
            );
        }

        // --- The original logic to update the appointments table ---
        const fields = [];
        const values = [];
        let query = 'UPDATE appointments SET ';

        if (status) {
            fields.push('status = $' + (fields.length + 1));
            values.push(status);
            if (status.toLowerCase() === 'checked-in') {
                fields.push('check_in_time = NOW()');
            }
        }
        if (doctor_id && appointment_date && appointment_time) {
            const appointmentTimestamp = `${appointment_date} ${appointment_time}`;
            fields.push('doctor_id = $' + (fields.length + 1), 'appointment_time = $' + (fields.length + 2));
            values.push(doctor_id, appointmentTimestamp);
        }
        if (purpose) {
            fields.push('purpose = $' + (fields.length + 1));
            values.push(purpose);
        }
        if (room_id) {
            fields.push('room_id = $' + (fields.length + 1));
            values.push(room_id);
        }
        if (confirmation_notes) {
            fields.push('confirmation_notes = $' + (fields.length + 1));
            values.push(confirmation_notes);
        }

        if (fields.length === 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: 'No valid fields provided for update.' });
        }

        query += fields.join(', ');
        query += ' WHERE appointment_id = $' + (values.length + 1) + ' RETURNING *';
        values.push(id);

        const { rows } = await client.query(query, values);
        
        // If everything is successful, commit the transaction
        await client.query('COMMIT');
        
        res.json(rows[0]);

    } catch (err) {
        // If any step fails, roll back all changes
        await client.query('ROLLBACK');
        handleError(res, err, `Failed to update appointment: ${err.message}`);
    } finally {
        // Release the database client back to the pool
        client.release();
    }
});




// ***************************************************************
// ** NEW ENDPOINT: Create a new room for a clinic **
// ***************************************************************
app.post('/api/rooms', authMiddleware, async (req, res) => {
    const { clinic_id, room_name } = req.body;
    if (!clinic_id || !room_name) {
        return res.status(400).json({ message: 'Clinic ID and room name are required.' });
    }
    try {
        const { rows } = await db.query(
            'INSERT INTO rooms (clinic_id, room_name) VALUES ($1, $2) RETURNING *',
            [clinic_id, room_name]
        );
        res.status(201).json(rows[0]);
    } catch (err) {
        console.error("Error in POST /api/rooms:", err.message);
        res.status(500).json({ message: 'Server Error' });
    }
});

app.get('/api/rooms', authMiddleware, async (req, res) => {
    const { clinic_id } = req.query;
    if (!clinic_id) {
        return res.status(400).json({ message: 'A clinic_id is required.' });
    }
    try {
        const { rows } = await db.query('SELECT room_id, room_name FROM rooms WHERE clinic_id = $1 ORDER BY room_name', [clinic_id]);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ message: err.message || 'Server error' });
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

// ***************************************************************
// ** UPGRADED: Creates appointment with new patient_id link **
// ***************************************************************
app.post('/api/appointments', authMiddleware, checkRole('nurse', 'doctor', 'admin'), async (req, res) => {
    const {
        customer_id, patient_id, doctor_id, clinic_id, appointment_date,
        appointment_time, status, patient_name_at_booking,
        patient_phone_at_booking, purpose, room_id,
        duration_minutes // <-- NEW FIELD
    } = req.body;

    // Comprehensive input validation
    if (!doctor_id || !clinic_id || !appointment_date || !appointment_time) {
        return res.status(400).json({ msg: 'Missing required appointment details.' });
    }

    // Validate date format
    const appointmentDate = new Date(appointment_date);
    if (isNaN(appointmentDate.getTime())) {
        return res.status(400).json({ msg: 'Invalid appointment date format.' });
    }

    // Validate time format (HH:MM)
    const timeRegex = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/;
    if (!timeRegex.test(appointment_time)) {
        return res.status(400).json({ msg: 'Invalid time format. Use HH:MM format.' });
    }

    // Validate appointment is not in the past
    const appointmentDateTime = new Date(`${appointment_date} ${appointment_time}`);
    if (appointmentDateTime < new Date()) {
        return res.status(400).json({ msg: 'Cannot create appointments in the past.' });
    }

    // Validate duration (if provided)
    if (duration_minutes && (duration_minutes < 5 || duration_minutes > 480)) {
        return res.status(400).json({ msg: 'Duration must be between 5 and 480 minutes.' });
    }

    // Validate status (if provided)
    const validStatuses = ['pending_confirmation', 'confirmed', 'checked-in', 'completed', 'cancelled'];
    if (status && !validStatuses.includes(status.toLowerCase())) {
        return res.status(400).json({ msg: 'Invalid appointment status.' });
    }

    try {
        const appointmentTimestamp = `${appointment_date} ${appointment_time}`;
        const duration = duration_minutes || 30; // Default to 30 mins if not provided

        const { rows } = await db.query(
            `INSERT INTO appointments (customer_id, patient_id, doctor_id, clinic_id, appointment_time, end_time, status, patient_name_at_booking, patient_phone_at_booking, purpose, room_id)
             VALUES ($1, $2, $3, $4, $5, $5::timestamptz + ($6 * interval '1 minute'), $7, $8, $9, $10, $11) RETURNING *`,
            [customer_id || null, patient_id || null, doctor_id, clinic_id, appointmentTimestamp, duration, status || 'confirmed', patient_name_at_booking, patient_phone_at_booking, purpose || null, room_id || null]
        );
        res.status(201).json(rows[0]);
    } catch (err) {
        console.error("Error in POST /api/appointments:", err.message);
        res.status(500).json({ message: 'Server Error' });
    }
});

app.patch('/api/appointments/:id', authMiddleware, async (req, res) => {
    const { id } = req.params;
    const { status, doctor_id, appointment_date, appointment_time, purpose, room_id, confirmation_notes } = req.body;
    try {
        const fields = [];
        const values = [];
        let query = 'UPDATE appointments SET ';
        if (status) { fields.push('status = $' + (fields.length + 1)); values.push(status); }
        if (doctor_id && appointment_date && appointment_time) {
            const appointmentTimestamp = `${appointment_date} ${appointment_time}`;
            fields.push('doctor_id = $' + (fields.length + 1)); values.push(doctor_id);
            fields.push('appointment_time = $' + (fields.length + 1)); values.push(appointmentTimestamp);
        }
        if (purpose) { fields.push('purpose = $' + (fields.length + 1)); values.push(purpose); }
        if (room_id) { fields.push('room_id = $' + (fields.length + 1)); values.push(room_id); }
        if (confirmation_notes) { fields.push('confirmation_notes = $' + (fields.length + 1)); values.push(confirmation_notes); }
        if (fields.length === 0) return res.status(400).json({ message: 'No valid fields provided for update.' });
        query += fields.join(', ');
        query += ' WHERE appointment_id = $' + (fields.length + 1) + ' RETURNING *';
        values.push(id);
        const { rows } = await db.query(query, values);
        res.json(rows[0]);
    } catch (err) {
        console.error("Error in PATCH /api/appointments/:id:", err.message);
        res.status(500).json({ message: 'Server Error' });
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


// --- NEW Treatment Plan Endpoints ---
app.get('/api/patients/:patientId', authMiddleware, async (req, res) => {
    const { patientId } = req.params;
    try {
        const { rows } = await db.query(
            'SELECT * FROM patients WHERE patient_id = $1',
            [patientId]
        );
        if (rows.length === 0) {
            return res.status(404).json({ message: 'Patient not found.' });
        }
        res.json(rows[0]);
    } catch (err) {
        console.error("Error in GET /api/patients/:patientId:", err.message);
        res.status(500).json({ message: 'Server Error' });
    }
});
// GET a patient's entire treatment history (plans, items, exams, documents)
app.get('/api/patients/:patientId/treatment-history', authMiddleware, async (req, res) => {
    const { patientId } = req.params;
    try {
        const plans = await db.query('SELECT * FROM treatment_plans WHERE patient_id = $1 ORDER BY plan_date DESC', [patientId]);
        const items = await db.query('SELECT ti.* FROM treatment_items ti JOIN treatment_plans tp ON ti.plan_id = tp.plan_id WHERE tp.patient_id = $1', [patientId]);
        const findings = await db.query('SELECT * FROM examination_findings WHERE patient_id = $1 ORDER BY finding_date DESC', [patientId]);
        const documents = await db.query('SELECT * FROM patient_documents WHERE patient_id = $1 ORDER BY uploaded_at DESC', [patientId]);

        res.json({
            plans: plans.rows,
            items: items.rows,
            findings: findings.rows,
            documents: documents.rows
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST a new examination finding
app.post('/api/examination-findings', authMiddleware, async (req, res) => {
    const { patient_id, doctor_id, chief_complaint, clinical_findings } = req.body;
    try {
        const newFinding = await db.query(
            'INSERT INTO examination_findings (patient_id, doctor_id, chief_complaint, clinical_findings) VALUES ($1, $2, $3, $4) RETURNING *',
            [patient_id, doctor_id, chief_complaint, clinical_findings]
        );
        res.status(201).json(newFinding.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST a new treatment plan and its items
app.post('/api/treatment-plans', authMiddleware, async (req, res) => {
    const { patient_id, doctor_id, status, notes, items } = req.body;
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');
        const planResult = await client.query(
            'INSERT INTO treatment_plans (patient_id, doctor_id, status, notes) VALUES ($1, $2, $3, $4) RETURNING plan_id',
            [patient_id, doctor_id, status, notes]
        );
        const planId = planResult.rows[0].plan_id;

        for (const item of items) {
            await client.query(
                'INSERT INTO treatment_items (plan_id, description, priority, status) VALUES ($1, $2, $3, $4)',
                [planId, item.description, item.priority, item.status]
            );
        }
        await client.query('COMMIT');
        res.status(201).json({ plan_id: planId });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

// PUT to update a treatment item's status or progress
app.put('/api/treatment-items/:itemId', authMiddleware, async (req, res) => {
    const { itemId } = req.params;
    const { status, progress } = req.body;
    try {
        const updatedItem = await db.query(
            'UPDATE treatment_items SET status = $1, progress = $2 WHERE item_id = $3 RETURNING *',
            [status, progress, itemId]
        );
        res.json(updatedItem.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
app.put('/api/patients/:patientId', authMiddleware, async (req, res) => {
    const { patientId } = req.params;
    const {
        dn, dn_old, id_verification_type, id_number, title_th, first_name_th, last_name_th,
        title_en, first_name_en, last_name_en, nickname, gender, date_of_birth,
        chronic_diseases, allergies, mobile_phone, home_phone, line_id, email,
        address, sub_district, district, province, country, zip_code,
        extreme_care_drugs, is_pregnant // Include the new alert fields
    } = req.body;

    try {
        const { rows } = await db.query(
            `UPDATE patients SET
                dn = $1, dn_old = $2, id_verification_type = $3, id_number = $4, title_th = $5,
                first_name_th = $6, last_name_th = $7, title_en = $8, first_name_en = $9,
                last_name_en = $10, nickname = $11, gender = $12, date_of_birth = $13,
                chronic_diseases = $14, allergies = $15, mobile_phone = $16, home_phone = $17,
                line_id = $18, email = $19, address = $20, sub_district = $21, district = $22,
                province = $23, country = $24, zip_code = $25, extreme_care_drugs = $26,
                is_pregnant = $27, updated_at = NOW()
            WHERE patient_id = $28 RETURNING *`,
            [
                dn, dn_old, id_verification_type, id_number, title_th, first_name_th, last_name_th,
                title_en, first_name_en, last_name_en, nickname, gender, date_of_birth,
                chronic_diseases, allergies, mobile_phone, home_phone, line_id, email,
                address, sub_district, district, province, country, zip_code,
                extreme_care_drugs, is_pregnant,
                patientId
            ]
        );
        if (rows.length === 0) {
            return res.status(404).json({ message: 'Patient not found.' });
        }
        res.json(rows[0]);
    } catch (err) {
        console.error("Error in PUT /api/patients/:patientId:", err.message);
        res.status(500).json({ message: 'Server Error' });
    }
});
// POST to upload a document (this would involve file handling middleware like multer)
app.post('/api/patients/:patientId/documents', authMiddleware, async (req, res) => {
    // This is a simplified example. You'd use a library like 'multer' to handle the file upload.
    const { patientId } = req.params;
    const { file_name, file_url, document_type } = req.body; // In reality, you'd get this info after uploading to cloud storage
    try {
        const newDoc = await db.query(
            'INSERT INTO patient_documents (patient_id, file_name, file_url, document_type) VALUES ($1, $2, $3, $4) RETURNING *',
            [patientId, file_name, file_url, document_type]
        );
        res.status(201).json(newDoc.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// --- Health Check Endpoint ---
app.get('/health', async (req, res) => {
    try {
        // Check database connection
        await db.query('SELECT 1');
        res.status(200).json({
            status: 'ok',
            timestamp: new Date().toISOString(),
            uptime: process.uptime(),
            environment: process.env.NODE_ENV || 'development',
            database: 'connected'
        });
    } catch (err) {
        res.status(503).json({
            status: 'error',
            timestamp: new Date().toISOString(),
            database: 'disconnected',
            error: process.env.NODE_ENV === 'production' ? 'Database unavailable' : err.message
        });
    }
});

// =====================================================================
// GROUP 1: TREATMENTS API
// =====================================================================

// GET all treatments
app.get('/api/treatments', authMiddleware, async (req, res) => {
    try {
        const { rows } = await db.query(
            `SELECT treatment_id, code, name, standard_price, category, description, created_at
             FROM treatments
             ORDER BY category, code`
        );
        res.json(rows);
    } catch (err) {
        handleError(res, err, 'Failed to fetch treatments');
    }
});

// GET treatments by search query
app.get('/api/treatments/search', authMiddleware, async (req, res) => {
    const { q } = req.query;

    if (!q || q.trim().length === 0) {
        return res.status(400).json({ message: 'Search query is required' });
    }

    try {
        const searchPattern = `%${q.trim()}%`;
        const { rows } = await db.query(
            `SELECT treatment_id, code, name, standard_price, category, description
             FROM treatments
             WHERE code ILIKE $1 OR name ILIKE $1
             ORDER BY code
             LIMIT 50`,
            [searchPattern]
        );
        res.json(rows);
    } catch (err) {
        handleError(res, err, 'Failed to search treatments');
    }
});

// POST create new treatment (nurse/admin only)
app.post('/api/treatments', authMiddleware, checkRole('nurse', 'admin'), async (req, res) => {
    const { code, name, standard_price, category, description } = req.body;

    // Validation
    if (!code || !name || standard_price === undefined) {
        return res.status(400).json({ message: 'Code, name, and standard_price are required' });
    }

    if (typeof code !== 'string' || code.trim().length === 0 || code.length > 50) {
        return res.status(400).json({ message: 'Code must be a non-empty string (max 50 characters)' });
    }

    if (typeof name !== 'string' || name.trim().length === 0 || name.length > 255) {
        return res.status(400).json({ message: 'Name must be a non-empty string (max 255 characters)' });
    }

    const price = parseFloat(standard_price);
    if (isNaN(price) || price < 0) {
        return res.status(400).json({ message: 'Standard price must be a positive number' });
    }

    try {
        const { rows } = await db.query(
            `INSERT INTO treatments (code, name, standard_price, category, description)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING *`,
            [code.trim().toUpperCase(), name.trim(), price, category || null, description || null]
        );
        res.status(201).json(rows[0]);
    } catch (err) {
        if (err.code === '23505') {
            return res.status(409).json({ message: 'A treatment with this code already exists' });
        }
        handleError(res, err, 'Failed to create treatment');
    }
});

// PUT update treatment (nurse/admin only)
app.put('/api/treatments/:id', authMiddleware, checkRole('nurse', 'admin'), async (req, res) => {
    const { id } = req.params;
    const { code, name, standard_price, category, description } = req.body;

    // Validation
    if (!code || !name || standard_price === undefined) {
        return res.status(400).json({ message: 'Code, name, and standard_price are required' });
    }

    const price = parseFloat(standard_price);
    if (isNaN(price) || price < 0) {
        return res.status(400).json({ message: 'Standard price must be a positive number' });
    }

    try {
        const { rows } = await db.query(
            `UPDATE treatments
             SET code = $1, name = $2, standard_price = $3, category = $4, description = $5
             WHERE treatment_id = $6
             RETURNING *`,
            [code.trim().toUpperCase(), name.trim(), price, category || null, description || null, id]
        );

        if (rows.length === 0) {
            return res.status(404).json({ message: 'Treatment not found' });
        }

        res.json(rows[0]);
    } catch (err) {
        if (err.code === '23505') {
            return res.status(409).json({ message: 'A treatment with this code already exists' });
        }
        handleError(res, err, 'Failed to update treatment');
    }
});

// DELETE treatment (admin only)
app.delete('/api/treatments/:id', authMiddleware, checkRole('admin'), async (req, res) => {
    const { id } = req.params;

    try {
        const { rows } = await db.query(
            'DELETE FROM treatments WHERE treatment_id = $1 RETURNING treatment_id',
            [id]
        );

        if (rows.length === 0) {
            return res.status(404).json({ message: 'Treatment not found' });
        }

        res.json({ message: 'Treatment deleted successfully' });
    } catch (err) {
        if (err.code === '23503') {
            return res.status(400).json({
                message: 'Cannot delete treatment. It is currently referenced in visit treatments.'
            });
        }
        handleError(res, err, 'Failed to delete treatment');
    }
});

// =====================================================================
// GROUP 2: VISITS API
// =====================================================================

// DEBUG endpoint to check all checked-in appointments
app.get('/api/debug/checked-in-appointments', authMiddleware, async (req, res) => {
    const { clinic_id } = req.query;

    console.log('=== DEBUG: Checking all checked-in appointments ===');
    console.log('Clinic ID:', clinic_id);

    try {
        const { rows } = await db.query(
            `SELECT a.appointment_id, a.patient_id, a.doctor_id, a.clinic_id,
                    a.status, a.appointment_time, a.check_in_time,
                    p.first_name_th, p.last_name_th, p.dn,
                    di.full_name as doctor_name
             FROM appointments a
             JOIN patients p ON a.patient_id = p.patient_id
             LEFT JOIN doctors_identities di ON a.doctor_id = di.doctor_id
             WHERE LOWER(a.status) = 'checked-in'
               ${clinic_id ? 'AND a.clinic_id = $1' : ''}
             ORDER BY a.check_in_time DESC`,
            clinic_id ? [clinic_id] : []
        );

        console.log('Found checked-in appointments:', rows);
        res.json(rows);
    } catch (err) {
        console.error('ERROR in debug endpoint:', err);
        res.status(500).json({ message: 'Failed to fetch debug data', error: err.message });
    }
});

// POST check-in patient (nurse/admin only)
app.post('/api/visits/check-in', authMiddleware, checkRole('nurse', 'admin'), async (req, res) => {
    const { patient_id, clinic_id, chief_complaint } = req.body;

    // Validation
    if (!patient_id || !clinic_id) {
        return res.status(400).json({ message: 'Patient ID and clinic ID are required' });
    }

    try {
        // Verify patient exists
        const patientCheck = await db.query(
            'SELECT patient_id FROM patients WHERE patient_id = $1',
            [patient_id]
        );

        if (patientCheck.rows.length === 0) {
            return res.status(404).json({ message: 'Patient not found' });
        }

        // Create visit with status 'waiting'
        const { rows } = await db.query(
            `INSERT INTO visits (patient_id, clinic_id, check_in_time, status)
             VALUES ($1, $2, NOW(), 'waiting')
             RETURNING *`,
            [patient_id, clinic_id]
        );

        res.status(201).json(rows[0]);
    } catch (err) {
        handleError(res, err, 'Failed to check in patient');
    }
});

// GET waiting queue (authenticated)
app.get('/api/visits/queue', authMiddleware, async (req, res) => {
    const { clinic_id } = req.query;

    if (!clinic_id) {
        return res.status(400).json({ message: 'Clinic ID is required' });
    }

    try {
        const { rows } = await db.query(
            `SELECT v.visit_id, v.patient_id, v.check_in_time, v.status,
                    v.doctor_id, v.waiting_alert_level as alert_level,
                    p.dn, p.first_name_th, p.last_name_th, p.date_of_birth,
                    p.chronic_diseases, p.allergies, p.extreme_care_drugs, p.is_pregnant,
                    di.full_name as doctor_name
             FROM visits v
             JOIN patients p ON v.patient_id = p.patient_id
             LEFT JOIN doctors_identities di ON v.doctor_id = di.doctor_id
             WHERE v.clinic_id = $1 AND v.status = 'waiting'
             ORDER BY v.waiting_alert_level DESC NULLS LAST, v.check_in_time ASC`,
            [clinic_id]
        );
        res.json(rows);
    } catch (err) {
        handleError(res, err, 'Failed to fetch queue');
    }
});

// GET queue for specific doctor (authenticated) - Supports status filtering
// Queries visits table (primary) with fallback to appointments table
app.get('/api/visits/queue/:doctor_id', authMiddleware, async (req, res) => {
    const { doctor_id } = req.params;
    const { clinic_id, status } = req.query;

    console.log('=== DOCTOR QUEUE ENDPOINT CALLED ===');
    console.log('Doctor ID:', doctor_id);
    console.log('Clinic ID:', clinic_id);
    console.log('Status filter:', status);

    if (!clinic_id) {
        return res.status(400).json({ message: 'Clinic ID is required' });
    }

    try {
        // Parse status filter (comma-separated statuses)
        // Map frontend statuses to database statuses
        const statusMap = {
            'checked-in': 'waiting',  // frontend uses 'checked-in', visits table uses 'waiting'
            'draft_checkout': 'draft_checkout',
            'completed': 'completed'
        };

        const statusFilter = status ?
            status.split(',').map(s => statusMap[s.trim().toLowerCase()] || s.trim().toLowerCase()) :
            ['waiting'];

        console.log('Parsed status filter:', statusFilter);

        // Build the status condition for SQL
        const statusConditions = statusFilter.map((_, index) => `LOWER(v.status) = $${index + 3}`).join(' OR ');

        // Fetch from visits table
        const queryParams = [clinic_id, doctor_id, ...statusFilter];

        const query = `SELECT v.visit_id, v.patient_id, v.check_in_time,
                LOWER(v.status) as status,
                CASE
                    WHEN v.waiting_alert_level ~ '^[0-9]+$' THEN v.waiting_alert_level::INTEGER
                    WHEN LOWER(v.waiting_alert_level) = 'urgent' THEN 3
                    WHEN LOWER(v.waiting_alert_level) = 'high' THEN 2
                    WHEN LOWER(v.waiting_alert_level) = 'medium' THEN 1
                    ELSE 0
                END as alert_level,
                p.dn, p.first_name_th, p.last_name_th, p.date_of_birth,
                p.chronic_diseases, p.allergies, p.extreme_care_drugs, p.is_pregnant
         FROM visits v
         JOIN patients p ON v.patient_id = p.patient_id
         WHERE v.clinic_id = $1 AND v.doctor_id = $2
           AND (${statusConditions})
         ORDER BY CASE
                    WHEN v.waiting_alert_level ~ '^[0-9]+$' THEN v.waiting_alert_level::INTEGER
                    WHEN LOWER(v.waiting_alert_level) = 'urgent' THEN 3
                    WHEN LOWER(v.waiting_alert_level) = 'high' THEN 2
                    WHEN LOWER(v.waiting_alert_level) = 'medium' THEN 1
                    ELSE 0
                END DESC, v.check_in_time ASC`;

        console.log('Query:', query);
        console.log('Query params:', queryParams);

        const { rows } = await db.query(query, queryParams);

        console.log('Queue from visits table:');
        console.log('Queue Length:', rows.length);
        rows.forEach(r => console.log(`  - Patient ${r.patient_id} (DN: ${r.dn}), Visit ID: ${r.visit_id}, Status: ${r.status}`));

        res.json(rows);
    } catch (err) {
        console.error('ERROR in doctor queue endpoint:', err);
        handleError(res, err, 'Failed to fetch doctor queue');
    }
});

// PUT assign doctor to visit (nurse/admin only)
app.put('/api/visits/:id/assign-doctor', authMiddleware, checkRole('nurse', 'admin'), async (req, res) => {
    const { id } = req.params;
    const { doctor_id } = req.body;

    if (!doctor_id) {
        return res.status(400).json({ message: 'Doctor ID is required' });
    }

    try {
        const { rows } = await db.query(
            `UPDATE visits
             SET doctor_id = $1, status = 'in_progress'
             WHERE visit_id = $2
             RETURNING *`,
            [doctor_id, id]
        );

        if (rows.length === 0) {
            return res.status(404).json({ message: 'Visit not found' });
        }

        res.json(rows[0]);
    } catch (err) {
        handleError(res, err, 'Failed to assign doctor');
    }
});

// GET visit details (authenticated)
app.get('/api/visits/:id', authMiddleware, async (req, res) => {
    const { id } = req.params;

    try {
        const { rows } = await db.query(
            `SELECT v.*,
                    p.dn, p.first_name_th, p.last_name_th, p.date_of_birth,
                    p.gender, p.mobile_phone, p.chronic_diseases, p.allergies,
                    p.extreme_care_drugs, p.is_pregnant,
                    di.full_name as doctor_name, di.specialty
             FROM visits v
             JOIN patients p ON v.patient_id = p.patient_id
             LEFT JOIN doctors_identities di ON v.doctor_id = di.doctor_id
             WHERE v.visit_id = $1`,
            [id]
        );

        if (rows.length === 0) {
            return res.status(404).json({ message: 'Visit not found' });
        }

        res.json(rows[0]);
    } catch (err) {
        handleError(res, err, 'Failed to fetch visit details');
    }
});

// PUT complete visit (doctor/admin only)
app.put('/api/visits/:id/complete', authMiddleware, checkRole('doctor', 'admin'), async (req, res) => {
    const { id } = req.params;

    try {
        const { rows } = await db.query(
            `UPDATE visits
             SET status = 'completed', check_out_time = NOW()
             WHERE visit_id = $1
             RETURNING *`,
            [id]
        );

        if (rows.length === 0) {
            return res.status(404).json({ message: 'Visit not found' });
        }

        res.json(rows[0]);
    } catch (err) {
        handleError(res, err, 'Failed to complete visit');
    }
});

// PUT checkout visit with password verification (doctor only)
app.put('/api/visits/:id/checkout', authMiddleware, checkRole('doctor'), async (req, res) => {
    const { id } = req.params;
    const { password, status } = req.body;

    if (!password) {
        return res.status(400).json({ message: 'Password is required' });
    }

    if (!status || !['draft_checkout', 'completed'].includes(status)) {
        return res.status(400).json({ message: 'Invalid status. Must be draft_checkout or completed' });
    }

    try {
        // Verify doctor's password
        const doctorCheck = await db.query(
            'SELECT password_hash FROM doctors_identities WHERE doctor_id = $1',
            [req.user.id]
        );

        if (doctorCheck.rows.length === 0) {
            return res.status(404).json({ message: 'Doctor not found' });
        }

        const passwordMatch = await bcrypt.compare(password, doctorCheck.rows[0].password_hash);

        if (!passwordMatch) {
            return res.status(401).json({ message: 'Incorrect password' });
        }

        // Update visit status (using visits table)
        const { rows } = await db.query(
            `UPDATE visits
             SET status = $1, check_out_time = CASE WHEN $1 = 'completed' THEN NOW() ELSE check_out_time END
             WHERE visit_id = $2
             RETURNING *`,
            [status, id]
        );

        if (rows.length === 0) {
            return res.status(404).json({ message: 'Visit not found' });
        }

        res.json(rows[0]);
    } catch (err) {
        handleError(res, err, 'Failed to checkout visit');
    }
});

// =====================================================================
// GROUP 3: EXAMINATION FINDINGS API
// =====================================================================

// POST create examination (doctor/admin only)
app.post('/api/examinations', authMiddleware, checkRole('doctor', 'admin'), async (req, res) => {
    const { visit_id, chief_complaint, clinical_findings, principal_diagnosis, present_illness, past_medical_history, location } = req.body;

    // Validation
    if (!visit_id) {
        return res.status(400).json({ message: 'Visit ID is required' });
    }

    try {
        // Verify visit exists (use appointments table)
        const visitCheck = await db.query(
            'SELECT appointment_id, status FROM appointments WHERE appointment_id = $1',
            [visit_id]
        );

        if (visitCheck.rows.length === 0) {
            return res.status(404).json({ message: 'Visit not found' });
        }

        // Get patient_id from appointment
        const appointment = visitCheck.rows[0];
        const patientId = await db.query(
            'SELECT patient_id FROM appointments WHERE appointment_id = $1',
            [visit_id]
        );

        const { rows } = await db.query(
            `INSERT INTO examination_findings
             (visit_id, patient_id, doctor_id, finding_date, chief_complaint, clinical_findings, principal_diagnosis, present_illness, past_medical_history, location)
             VALUES ($1, $2, $3, CURRENT_DATE, $4, $5, $6, $7, $8, $9)
             RETURNING *`,
            [
                visit_id,
                patientId.rows[0].patient_id,
                req.user.id,
                chief_complaint || null,
                clinical_findings || null,
                principal_diagnosis || null,
                present_illness || null,
                past_medical_history || null,
                location || null
            ]
        );

        res.status(201).json(rows[0]);
    } catch (err) {
        handleError(res, err, 'Failed to create examination');
    }
});

// GET examination by visit (authenticated)
app.get('/api/examinations/visit/:visit_id', authMiddleware, async (req, res) => {
    const { visit_id } = req.params;

    try {
        const { rows } = await db.query(
            `SELECT ef.*,
                    a.patient_id, a.appointment_time as visit_date, a.check_in_time,
                    p.dn, p.first_name_th, p.last_name_th,
                    di.full_name as doctor_name, di.specialty
             FROM examination_findings ef
             JOIN appointments a ON ef.visit_id = a.appointment_id
             JOIN patients p ON a.patient_id = p.patient_id
             JOIN doctors_identities di ON ef.doctor_id = di.doctor_id
             WHERE ef.visit_id = $1`,
            [visit_id]
        );

        if (rows.length === 0) {
            return res.json(null);
        }

        res.json(rows[0]);
    } catch (err) {
        handleError(res, err, 'Failed to fetch examination');
    }
});

// PUT update examination (doctor/admin only)
app.put('/api/examinations/:id', authMiddleware, checkRole('doctor', 'admin'), async (req, res) => {
    const { id } = req.params;
    const { chief_complaint, clinical_findings, principal_diagnosis, present_illness, past_medical_history, location } = req.body;

    try {
        // Check ownership (only creating doctor can update, unless admin)
        const ownerCheck = await db.query(
            'SELECT doctor_id FROM examination_findings WHERE finding_id = $1',
            [id]
        );

        if (ownerCheck.rows.length === 0) {
            return res.status(404).json({ message: 'Examination not found' });
        }

        if (req.user.role !== 'admin' && ownerCheck.rows[0].doctor_id !== req.user.id) {
            return res.status(403).json({ message: 'You can only update your own examinations' });
        }

        const { rows } = await db.query(
            `UPDATE examination_findings
             SET chief_complaint = $1, clinical_findings = $2, principal_diagnosis = $3,
                 present_illness = $4, past_medical_history = $5, location = $6
             WHERE finding_id = $7
             RETURNING *`,
            [
                chief_complaint || null,
                clinical_findings || null,
                principal_diagnosis || null,
                present_illness || null,
                past_medical_history || null,
                location || null,
                id
            ]
        );

        res.json(rows[0]);
    } catch (err) {
        handleError(res, err, 'Failed to update examination');
    }
});

// GET single examination (authenticated)
app.get('/api/examinations/:id', authMiddleware, async (req, res) => {
    const { id } = req.params;

    try {
        const { rows } = await db.query(
            `SELECT ef.*,
                    v.patient_id, v.visit_date,
                    p.dn, p.first_name_th, p.last_name_th,
                    di.full_name as doctor_name
             FROM examination_findings ef
             JOIN visits v ON ef.visit_id = v.visit_id
             JOIN patients p ON v.patient_id = p.patient_id
             JOIN doctors_identities di ON ef.doctor_id = di.doctor_id
             WHERE ef.finding_id = $1`,
            [id]
        );

        if (rows.length === 0) {
            return res.status(404).json({ message: 'Examination not found' });
        }

        res.json(rows[0]);
    } catch (err) {
        handleError(res, err, 'Failed to fetch examination');
    }
});

// =====================================================================
// GROUP 4: TREATMENT PLANS API
// =====================================================================

// POST create treatment plan (doctor/admin only)
app.post('/api/treatment-plans', authMiddleware, checkRole('doctor', 'admin'), async (req, res) => {
    const { visit_id, notes, status } = req.body;

    // Validation
    if (!visit_id) {
        return res.status(400).json({ message: 'Visit ID is required' });
    }

    try {
        // Get patient_id from appointment (visit)
        const visitCheck = await db.query(
            'SELECT patient_id FROM appointments WHERE appointment_id = $1',
            [visit_id]
        );

        if (visitCheck.rows.length === 0) {
            return res.status(404).json({ message: 'Visit not found' });
        }

        const { rows } = await db.query(
            `INSERT INTO treatment_plans
             (visit_id, patient_id, doctor_id, plan_date, status, notes)
             VALUES ($1, $2, $3, CURRENT_DATE, $4, $5)
             RETURNING *`,
            [
                visit_id,
                visitCheck.rows[0].patient_id,
                req.user.id,
                status || 'active',
                notes || null
            ]
        );

        res.status(201).json(rows[0]);
    } catch (err) {
        handleError(res, err, 'Failed to create treatment plan');
    }
});

// GET treatment plan by visit (authenticated)
app.get('/api/treatment-plans/visit/:visit_id', authMiddleware, async (req, res) => {
    const { visit_id } = req.params;

    try {
        const { rows } = await db.query(
            `SELECT tp.*,
                    di.full_name as doctor_name,
                    p.first_name_th, p.last_name_th
             FROM treatment_plans tp
             JOIN doctors_identities di ON tp.doctor_id = di.doctor_id
             JOIN patients p ON tp.patient_id = p.patient_id
             WHERE tp.visit_id = $1`,
            [visit_id]
        );

        if (rows.length === 0) {
            return res.json(null);
        }

        res.json(rows[0]);
    } catch (err) {
        handleError(res, err, 'Failed to fetch treatment plan');
    }
});

// PUT update treatment plan (doctor/admin only)
app.put('/api/treatment-plans/:id', authMiddleware, checkRole('doctor', 'admin'), async (req, res) => {
    const { id } = req.params;
    const { status, notes } = req.body;

    try {
        // Check ownership
        const ownerCheck = await db.query(
            'SELECT doctor_id FROM treatment_plans WHERE plan_id = $1',
            [id]
        );

        if (ownerCheck.rows.length === 0) {
            return res.status(404).json({ message: 'Treatment plan not found' });
        }

        if (req.user.role !== 'admin' && ownerCheck.rows[0].doctor_id !== req.user.id) {
            return res.status(403).json({ message: 'You can only update your own treatment plans' });
        }

        const { rows } = await db.query(
            `UPDATE treatment_plans
             SET status = COALESCE($1, status), notes = COALESCE($2, notes), updated_at = CURRENT_TIMESTAMP
             WHERE plan_id = $3
             RETURNING *`,
            [
                status,
                notes,
                id
            ]
        );

        res.json(rows[0]);
    } catch (err) {
        handleError(res, err, 'Failed to update treatment plan');
    }
});

// DELETE treatment plan (doctor/admin only)
app.delete('/api/treatment-plans/:id', authMiddleware, checkRole('doctor', 'admin'), async (req, res) => {
    const { id } = req.params;

    try {
        // Check ownership
        const ownerCheck = await db.query(
            'SELECT doctor_id FROM treatment_plans WHERE plan_id = $1',
            [id]
        );

        if (ownerCheck.rows.length === 0) {
            return res.status(404).json({ message: 'Treatment plan not found' });
        }

        if (req.user.role !== 'admin' && ownerCheck.rows[0].doctor_id !== req.user.id) {
            return res.status(403).json({ message: 'You can only delete your own treatment plans' });
        }

        await db.query('DELETE FROM treatment_plans WHERE plan_id = $1', [id]);

        res.json({ message: 'Treatment plan deleted successfully' });
    } catch (err) {
        handleError(res, err, 'Failed to delete treatment plan');
    }
});

// =====================================================================
// GROUP 5: VISIT TREATMENTS API
// =====================================================================

// POST add treatment to visit (doctor/nurse/admin)
app.post('/api/visit-treatments', authMiddleware, checkRole('doctor', 'nurse', 'admin'), async (req, res) => {
    const { visit_id, treatment_id, quantity, custom_price } = req.body;

    // Validation
    if (!visit_id || !treatment_id || !quantity) {
        return res.status(400).json({ message: 'Visit ID, treatment ID, and quantity are required' });
    }

    const qty = parseInt(quantity);
    if (isNaN(qty) || qty <= 0) {
        return res.status(400).json({ message: 'Quantity must be a positive number' });
    }

    try {
        // Verify visit exists
        const visitCheck = await db.query(
            'SELECT visit_id FROM visits WHERE visit_id = $1',
            [visit_id]
        );

        if (visitCheck.rows.length === 0) {
            return res.status(404).json({ message: 'Visit not found' });
        }

        // Get treatment standard price
        const treatmentCheck = await db.query(
            'SELECT standard_price FROM treatments WHERE treatment_id = $1',
            [treatment_id]
        );

        if (treatmentCheck.rows.length === 0) {
            return res.status(404).json({ message: 'Treatment not found' });
        }

        const price = custom_price !== undefined ? parseFloat(custom_price) : treatmentCheck.rows[0].standard_price;
        const total = price * qty;

        const { rows } = await db.query(
            `INSERT INTO visit_treatments
             (visit_id, treatment_id, quantity, price, total_price)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING *`,
            [visit_id, treatment_id, qty, price, total]
        );

        res.status(201).json(rows[0]);
    } catch (err) {
        handleError(res, err, 'Failed to add treatment to visit');
    }
});

// GET all treatments for a visit (authenticated)
app.get('/api/visit-treatments/visit/:visit_id', authMiddleware, async (req, res) => {
    const { visit_id } = req.params;

    try {
        // THE FIX: Changed ORDER BY from "vt.created_at" to "vt.visit_treatment_id"
        const { rows } = await db.query(
            `SELECT vt.*,
                    t.code, t.name, t.category, t.standard_price
             FROM visit_treatments vt
             JOIN treatments t ON vt.treatment_id = t.treatment_id
             WHERE vt.visit_id = $1
             ORDER BY vt.visit_treatment_id`, // <-- FIX IS HERE
            [visit_id]
        );
        res.json(rows);
    } catch (err) {
        handleError(res, err, 'Failed to fetch visit treatments');
    }
});

// PUT update visit treatment (doctor/nurse/admin)
app.put('/api/visit-treatments/:id', authMiddleware, checkRole('doctor', 'nurse', 'admin'), async (req, res) => {
    const { id } = req.params;
    const { quantity, custom_price } = req.body;

    if (!quantity) {
        return res.status(400).json({ message: 'Quantity is required' });
    }

    const qty = parseInt(quantity);
    if (isNaN(qty) || qty <= 0) {
        return res.status(400).json({ message: 'Quantity must be a positive number' });
    }

    try {
        // Get current visit treatment and standard price
        const current = await db.query(
            `SELECT vt.price, t.standard_price
             FROM visit_treatments vt
             JOIN treatments t ON vt.treatment_id = t.treatment_id
             WHERE vt.visit_treatment_id = $1`,
            [id]
        );

        if (current.rows.length === 0) {
            return res.status(404).json({ message: 'Visit treatment not found' });
        }

        const price = custom_price !== undefined ? parseFloat(custom_price) : current.rows[0].price;
        const total = price * qty;

        const { rows } = await db.query(
            `UPDATE visit_treatments
             SET quantity = $1, price = $2, total_price = $3
             WHERE visit_treatment_id = $4
             RETURNING *`,
            [qty, price, total, id]
        );

        res.json(rows[0]);
    } catch (err) {
        handleError(res, err, 'Failed to update visit treatment');
    }
});

// DELETE visit treatment (doctor/nurse/admin)
app.delete('/api/visit-treatments/:id', authMiddleware, checkRole('doctor', 'nurse', 'admin'), async (req, res) => {
    const { id } = req.params;

    try {
        const { rows } = await db.query(
            'DELETE FROM visit_treatments WHERE visit_treatment_id = $1 RETURNING visit_treatment_id',
            [id]
        );

        if (rows.length === 0) {
            return res.status(404).json({ message: 'Visit treatment not found' });
        }

        res.json({ message: 'Visit treatment removed successfully' });
    } catch (err) {
        handleError(res, err, 'Failed to remove visit treatment');
    }
});

// GET single visit treatment (authenticated)
app.get('/api/visit-treatments/:id', authMiddleware, async (req, res) => {
    const { id } = req.params;

    try {
        const { rows } = await db.query(
            `SELECT vt.*,
                    t.code, t.name, t.category, t.standard_price
             FROM visit_treatments vt
             JOIN treatments t ON vt.treatment_id = t.treatment_id
             WHERE vt.visit_treatment_id = $1`,
            [id]
        );

        if (rows.length === 0) {
            return res.status(404).json({ message: 'Visit treatment not found' });
        }

        res.json(rows[0]);
    } catch (err) {
        handleError(res, err, 'Failed to fetch visit treatment');
    }
});

// =====================================================================
// GROUP 6: BILLING API
// =====================================================================

// POST generate bill for a visit (nurse/admin only)
app.post('/api/billing/generate/:visit_id', authMiddleware, checkRole('nurse', 'admin'), async (req, res) => {
    const { visit_id } = req.params;
    const { discount, notes } = req.body;

    try {
        // Verify visit exists
        const visitCheck = await db.query(
            'SELECT visit_id, patient_id FROM visits WHERE visit_id = $1',
            [visit_id]
        );

        if (visitCheck.rows.length === 0) {
            return res.status(404).json({ message: 'Visit not found' });
        }

        // Check if bill already exists
        const existingBill = await db.query(
            'SELECT billing_id FROM billing WHERE visit_id = $1',
            [visit_id]
        );

        if (existingBill.rows.length > 0) {
            return res.status(400).json({
                message: 'Bill already exists for this visit',
                billing_id: existingBill.rows[0].billing_id
            });
        }

        // Calculate total from visit_treatments
        const totalCalc = await db.query(
            'SELECT COALESCE(SUM(total_price), 0) as total FROM visit_treatments WHERE visit_id = $1',
            [visit_id]
        );

        const subtotal = parseFloat(totalCalc.rows[0].total);
        const discountAmount = discount ? parseFloat(discount) : 0;
        const total = subtotal - discountAmount;

        if (total < 0) {
            return res.status(400).json({ message: 'Total amount cannot be negative' });
        }

        const { rows } = await db.query(
            `INSERT INTO billing
             (visit_id, patient_id, total_amount, discount, status, notes)
             VALUES ($1, $2, $3, $4, 'pending', $5)
             RETURNING *`,
            [visit_id, visitCheck.rows[0].patient_id, total, discountAmount, notes || null]
        );

        res.status(201).json(rows[0]);
    } catch (err) {
        handleError(res, err, 'Failed to generate bill');
    }
});

// GET bill details (authenticated)
app.get('/api/billing/:id', authMiddleware, async (req, res) => {
    const { id } = req.params;

    try {
        const { rows } = await db.query(
            `SELECT b.*,
                    v.visit_date, v.check_in_time, v.checkout_time,
                    p.dn, p.first_name_th, p.last_name_th, p.mobile_phone,
                    di.full_name as doctor_name
             FROM billing b
             JOIN visits v ON b.visit_id = v.visit_id
             JOIN patients p ON b.patient_id = p.patient_id
             LEFT JOIN doctors_identities di ON v.doctor_id = di.doctor_id
             WHERE b.billing_id = $1`,
            [id]
        );

        if (rows.length === 0) {
            return res.status(404).json({ message: 'Bill not found' });
        }

        // Get itemized treatments
        const items = await db.query(
            `SELECT vt.*, t.code, t.name
             FROM visit_treatments vt
             JOIN treatments t ON vt.treatment_id = t.treatment_id
             WHERE vt.visit_id = $1`,
            [rows[0].visit_id]
        );

        res.json({
            ...rows[0],
            items: items.rows
        });
    } catch (err) {
        handleError(res, err, 'Failed to fetch bill details');
    }
});

// GET bill by visit (authenticated)
app.get('/api/billing/visit/:visit_id', authMiddleware, async (req, res) => {
    const { visit_id } = req.params;

    try {
        const { rows } = await db.query(
            `SELECT b.*,
                    p.dn, p.first_name_th, p.last_name_th
             FROM billing b
             JOIN patients p ON b.patient_id = p.patient_id
             WHERE b.visit_id = $1`,
            [visit_id]
        );

        if (rows.length === 0) {
            return res.status(404).json({ message: 'Bill not found for this visit' });
        }

        res.json(rows[0]);
    } catch (err) {
        handleError(res, err, 'Failed to fetch bill');
    }
});

// PUT record payment (nurse/admin only)
app.put('/api/billing/:id/payment', authMiddleware, checkRole('nurse', 'admin'), async (req, res) => {
    const { id } = req.params;
    const { payment_method, paid_amount } = req.body;

    // Validation
    if (!payment_method || paid_amount === undefined) {
        return res.status(400).json({ message: 'Payment method and paid amount are required' });
    }

    const validMethods = ['cash', 'card', 'transfer', 'promptpay', 'other'];
    if (!validMethods.includes(payment_method.toLowerCase())) {
        return res.status(400).json({
            message: 'Invalid payment method',
            validMethods
        });
    }

    const amount = parseFloat(paid_amount);
    if (isNaN(amount) || amount < 0) {
        return res.status(400).json({ message: 'Paid amount must be a positive number' });
    }

    try {
        // Get bill details
        const billCheck = await db.query(
            'SELECT total_amount, status FROM billing WHERE billing_id = $1',
            [id]
        );

        if (billCheck.rows.length === 0) {
            return res.status(404).json({ message: 'Bill not found' });
        }

        if (billCheck.rows[0].status === 'paid') {
            return res.status(400).json({ message: 'Bill is already paid' });
        }

        const totalAmount = parseFloat(billCheck.rows[0].total_amount);
        if (Math.abs(amount - totalAmount) > 0.01) {
            return res.status(400).json({
                message: 'Paid amount does not match bill total',
                expected: totalAmount,
                received: amount
            });
        }

        const { rows } = await db.query(
            `UPDATE billing
             SET payment_method = $1, paid_amount = $2, payment_date = NOW(), status = 'paid'
             WHERE billing_id = $3
             RETURNING *`,
            [payment_method.toLowerCase(), amount, id]
        );

        res.json(rows[0]);
    } catch (err) {
        handleError(res, err, 'Failed to record payment');
    }
});

// GET all pending bills (nurse/admin only)
app.get('/api/billing/pending', authMiddleware, checkRole('nurse', 'admin'), async (req, res) => {
    const { clinic_id } = req.query;

    if (!clinic_id) {
        return res.status(400).json({ message: 'Clinic ID is required' });
    }

    try {
        const { rows } = await db.query(
            `SELECT b.billing_id, b.total_amount, b.created_at,
                    v.visit_date, v.visit_id,
                    p.dn, p.first_name_th, p.last_name_th
             FROM billing b
             JOIN visits v ON b.visit_id = v.visit_id
             JOIN patients p ON b.patient_id = p.patient_id
             WHERE v.clinic_id = $1 AND b.status = 'pending'
             ORDER BY b.created_at DESC`,
            [clinic_id]
        );

        res.json(rows);
    } catch (err) {
        handleError(res, err, 'Failed to fetch pending bills');
    }
});

// GET billing history (admin only)
app.get('/api/billing/history', authMiddleware, checkRole('admin'), async (req, res) => {
    const { clinic_id, start_date, end_date, page = 1, limit = 50 } = req.query;

    if (!clinic_id) {
        return res.status(400).json({ message: 'Clinic ID is required' });
    }

    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const offset = (pageNum - 1) * limitNum;

    try {
        let query = `
            SELECT b.*,
                   v.visit_date,
                   p.dn, p.first_name_th, p.last_name_th
            FROM billing b
            JOIN visits v ON b.visit_id = v.visit_id
            JOIN patients p ON b.patient_id = p.patient_id
            WHERE v.clinic_id = $1
        `;
        const params = [clinic_id];

        if (start_date) {
            params.push(start_date);
            query += ` AND b.created_at >= $${params.length}`;
        }

        if (end_date) {
            params.push(end_date);
            query += ` AND b.created_at <= $${params.length}`;
        }

        query += ` ORDER BY b.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
        params.push(limitNum, offset);

        const { rows } = await db.query(query, params);

        // Get total count
        let countQuery = `
            SELECT COUNT(*)
            FROM billing b
            JOIN visits v ON b.visit_id = v.visit_id
            WHERE v.clinic_id = $1
        `;
        const countParams = [clinic_id];

        if (start_date) {
            countParams.push(start_date);
            countQuery += ` AND b.created_at >= $${countParams.length}`;
        }

        if (end_date) {
            countParams.push(end_date);
            countQuery += ` AND b.created_at <= $${countParams.length}`;
        }

        const { rows: countResult } = await db.query(countQuery, countParams);
        const total = parseInt(countResult[0].count);

        res.json({
            data: rows,
            pagination: {
                page: pageNum,
                limit: limitNum,
                total,
                totalPages: Math.ceil(total / limitNum)
            }
        });
    } catch (err) {
        handleError(res, err, 'Failed to fetch billing history');
    }
});

// =====================================================================
// GROUP 7: HISTORY & REPORTING API
// =====================================================================

// GET complete patient history (authenticated)
app.get('/api/history/patient/:patient_id', authMiddleware, async (req, res) => {
    const { patient_id } = req.params;

    try {
        // Get all completed visits with examination findings and billing
        const { rows } = await db.query(
            `SELECT
                v.visit_id,
                DATE(v.check_in_time) as visit_date,
                v.check_in_time,
                v.check_out_time,
                v.status,
                di.full_name as doctor_name,
                di.specialty,
                ef.finding_id,
                ef.chief_complaint,
                ef.clinical_findings,
                ef.principal_diagnosis,
                b.billing_id,
                b.total_amount,
                b.payment_method,
                b.payment_status
             FROM visits v
             LEFT JOIN doctors_identities di ON v.doctor_id = di.doctor_id
             LEFT JOIN examination_findings ef ON v.visit_id = ef.visit_id
             LEFT JOIN billing b ON v.visit_id = b.visit_id
             WHERE v.patient_id = $1 AND v.status IN ('completed', 'checked-out')
             ORDER BY v.check_in_time DESC`,
            [patient_id]
        );

        const visitIds = rows.map(r => r.visit_id);
        let treatments = [];
        let plans = [];

        if (visitIds.length > 0) {
            const treatmentsResult = await db.query(
                `SELECT vt.visit_id, vt.actual_price as price, vt.tooth_numbers, vt.notes, t.code, t.name, t.category
                 FROM visit_treatments vt JOIN treatments t ON vt.treatment_id = t.treatment_id
                 WHERE vt.visit_id = ANY($1::int[])
                 ORDER BY vt.visit_treatment_id`,
                [visitIds]
            );
            treatments = treatmentsResult.rows;

            if (visitIds.length > 0) {
                const plansResult = await db.query(
                    `SELECT * FROM treatment_plans WHERE visit_id = ANY($1::int[])`,
                    [visitIds]
                );
                plans = plansResult.rows;
            }
        }

        const history = rows.map(visit => ({
            ...visit,
            treatments: treatments.filter(t => t.visit_id === visit.visit_id),
            plan: plans.find(p => p.visit_id === visit.visit_id) || null
        }));

        res.json(history);
    } catch (err) {
        handleError(res, err, 'Failed to fetch patient history');
    }
});


// GET visit details for PDF generation (authenticated)
app.get('/api/history/visit/:visit_id/pdf', authMiddleware, async (req, res) => {
    const { visit_id } = req.params;

    try {
        // Get complete visit information
        const visitData = await db.query(
            `SELECT
                v.*,
                p.dn, p.title_th, p.first_name_th, p.last_name_th, p.date_of_birth,
                p.gender, p.mobile_phone, p.address, p.chronic_diseases, p.allergies,
                di.full_name as doctor_name, di.specialty,
                c.name as clinic_name
             FROM visits v
             JOIN patients p ON v.patient_id = p.patient_id
             LEFT JOIN doctors_identities di ON v.doctor_id = di.doctor_id
             JOIN clinics c ON v.clinic_id = c.clinic_id
             WHERE v.visit_id = $1`,
            [visit_id]
        );

        if (visitData.rows.length === 0) {
            return res.status(404).json({ message: 'Visit not found' });
        }

        // Get examination findings
        const exam = await db.query(
            `SELECT * FROM examination_findings WHERE visit_id = $1`,
            [visit_id]
        );

        // Get treatment plan
        const plan = await db.query(
            `SELECT tp.* FROM treatment_plans tp
             JOIN examination_findings ef ON tp.examination_id = ef.finding_id
             WHERE ef.visit_id = $1`,
            [visit_id]
        );

        // Get treatments
        const treatments = await db.query(
            `SELECT vt.quantity, vt.price, vt.total_price,
                    t.code, t.name
             FROM visit_treatments vt
             JOIN treatments t ON vt.treatment_id = t.treatment_id
             WHERE vt.visit_id = $1`,
            [visit_id]
        );

        // Get billing
        const billing = await db.query(
            `SELECT * FROM billing WHERE visit_id = $1`,
            [visit_id]
        );

        // Return structured data for PDF generation (frontend will handle PDF creation)
        res.json({
            visit: visitData.rows[0],
            examination: exam.rows[0] || null,
            treatmentPlan: plan.rows[0] || null,
            treatments: treatments.rows,
            billing: billing.rows[0] || null
        });
    } catch (err) {
        handleError(res, err, 'Failed to fetch visit details for PDF');
    }
});

// GET daily summary report (admin only)
app.get('/api/reports/daily-summary', authMiddleware, checkRole('admin'), async (req, res) => {
    const { clinic_id, date } = req.query;

    if (!clinic_id || !date) {
        return res.status(400).json({ message: 'Clinic ID and date are required' });
    }

    try {
        // Total visits
        const visitsResult = await db.query(
            `SELECT COUNT(*) as total_visits,
                    COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed_visits,
                    COUNT(CASE WHEN status = 'waiting' THEN 1 END) as waiting_visits,
                    COUNT(CASE WHEN status = 'in_progress' THEN 1 END) as in_progress_visits
             FROM visits
             WHERE clinic_id = $1 AND visit_date = $2`,
            [clinic_id, date]
        );

        // Total revenue
        const revenueResult = await db.query(
            `SELECT COALESCE(SUM(b.total_amount), 0) as total_revenue,
                    COALESCE(SUM(CASE WHEN b.status = 'paid' THEN b.total_amount ELSE 0 END), 0) as paid_revenue,
                    COALESCE(SUM(CASE WHEN b.status = 'pending' THEN b.total_amount ELSE 0 END), 0) as pending_revenue
             FROM billing b
             JOIN visits v ON b.visit_id = v.visit_id
             WHERE v.clinic_id = $1 AND v.visit_date = $2`,
            [clinic_id, date]
        );

        // Top treatments
        const treatmentsResult = await db.query(
            `SELECT t.code, t.name,
                    COUNT(*) as usage_count,
                    SUM(vt.quantity) as total_quantity,
                    SUM(vt.total_price) as total_revenue
             FROM visit_treatments vt
             JOIN treatments t ON vt.treatment_id = t.treatment_id
             JOIN visits v ON vt.visit_id = v.visit_id
             WHERE v.clinic_id = $1 AND v.visit_date = $2
             GROUP BY t.treatment_id, t.code, t.name
             ORDER BY usage_count DESC
             LIMIT 10`,
            [clinic_id, date]
        );

        // Doctor statistics
        const doctorsResult = await db.query(
            `SELECT di.full_name as doctor_name,
                    COUNT(v.visit_id) as total_visits,
                    COUNT(CASE WHEN v.status = 'completed' THEN 1 END) as completed_visits
             FROM visits v
             JOIN doctors_identities di ON v.doctor_id = di.doctor_id
             WHERE v.clinic_id = $1 AND v.visit_date = $2
             GROUP BY di.doctor_id, di.full_name
             ORDER BY total_visits DESC`,
            [clinic_id, date]
        );

        res.json({
            date,
            clinic_id,
            visits: visitsResult.rows[0],
            revenue: revenueResult.rows[0],
            topTreatments: treatmentsResult.rows,
            doctorStats: doctorsResult.rows
        });
    } catch (err) {
        handleError(res, err, 'Failed to generate daily summary');
    }
});

app.listen(port, () => {
    console.log(`✅ Server started on port ${port}`);
});