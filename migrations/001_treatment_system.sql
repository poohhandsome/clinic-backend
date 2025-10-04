-- ═══════════════════════════════════════════════════════════════════════════
-- TREATMENT MANAGEMENT SYSTEM - DATABASE SCHEMA
-- Migration: 001_treatment_system.sql
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. CREATE TABLE: treatments (Master list of standardized treatments)
CREATE TABLE IF NOT EXISTS treatments (
  treatment_id SERIAL PRIMARY KEY,
  code VARCHAR(50) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  standard_price DECIMAL(10,2) NOT NULL,
  category VARCHAR(100),
  description TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 2. CREATE TABLE: visits (Patient queue & check-in/out tracking)
CREATE TABLE IF NOT EXISTS visits (
  visit_id SERIAL PRIMARY KEY,
  patient_id INTEGER NOT NULL REFERENCES patients(patient_id) ON DELETE CASCADE,
  doctor_id INTEGER REFERENCES doctors_identities(doctor_id) ON DELETE SET NULL,
  clinic_id INTEGER REFERENCES clinics(clinic_id) ON DELETE SET NULL,
  check_in_time TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  check_out_time TIMESTAMP WITH TIME ZONE,
  status VARCHAR(50) DEFAULT 'waiting',
  waiting_alert_level VARCHAR(50) DEFAULT 'normal',
  visit_type VARCHAR(50),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 3. CREATE TABLE: billing (Counter payments)
CREATE TABLE IF NOT EXISTS billing (
  billing_id SERIAL PRIMARY KEY,
  visit_id INTEGER NOT NULL REFERENCES visits(visit_id) ON DELETE CASCADE,
  total_amount DECIMAL(10,2) NOT NULL,
  payment_status VARCHAR(50) DEFAULT 'pending',
  payment_method VARCHAR(50),
  paid_at TIMESTAMP WITH TIME ZONE,
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 4. CREATE TABLE: visit_treatments (Actual treatments performed during visit)
CREATE TABLE IF NOT EXISTS visit_treatments (
  visit_treatment_id SERIAL PRIMARY KEY,
  visit_id INTEGER NOT NULL REFERENCES visits(visit_id) ON DELETE CASCADE,
  treatment_id INTEGER NOT NULL REFERENCES treatments(treatment_id) ON DELETE RESTRICT,
  actual_price DECIMAL(10,2) NOT NULL,
  tooth_numbers VARCHAR(100),
  notes TEXT,
  performed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_visits_patient_id ON visits(patient_id);
CREATE INDEX IF NOT EXISTS idx_visits_doctor_id ON visits(doctor_id);
CREATE INDEX IF NOT EXISTS idx_visits_status ON visits(status);
CREATE INDEX IF NOT EXISTS idx_billing_visit_id ON billing(visit_id);
CREATE INDEX IF NOT EXISTS idx_billing_payment_status ON billing(payment_status);
CREATE INDEX IF NOT EXISTS idx_visit_treatments_visit_id ON visit_treatments(visit_id);
CREATE INDEX IF NOT EXISTS idx_treatments_code ON treatments(code);
CREATE INDEX IF NOT EXISTS idx_treatments_category ON treatments(category);
