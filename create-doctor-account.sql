-- Create Doctor Account
-- Username: doctor@clinic.com
-- Password: Doctor123

BEGIN;

-- Insert doctor identity
INSERT INTO doctors_identities (full_name, specialty, email, password_hash, color, status)
VALUES ('Dr. Test Doctor', 'General Practice', 'doctor@clinic.com', '$2b$10$cYUiIutx34GHFvJH4vNPJODPal1IipznTsTzkfJIabBNrA0AOLA9.', '#3B82F6', 'active')
RETURNING doctor_id;

-- Note: After running this, you need to assign the doctor to a clinic
-- Replace {doctor_id} with the returned doctor_id and {clinic_id} with your clinic ID
-- INSERT INTO doctor_clinic_assignments (doctor_id, clinic_id) VALUES ({doctor_id}, {clinic_id});

COMMIT;
