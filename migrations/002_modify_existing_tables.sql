-- ═══════════════════════════════════════════════════════════════════════════
-- TREATMENT MANAGEMENT SYSTEM - MODIFY EXISTING TABLES
-- Migration: 002_modify_existing_tables.sql
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. MODIFY TABLE: examination_findings
-- Add columns for visit tracking and additional medical history
ALTER TABLE examination_findings
ADD COLUMN IF NOT EXISTS visit_id INTEGER REFERENCES visits(visit_id) ON DELETE CASCADE,
ADD COLUMN IF NOT EXISTS present_illness TEXT,
ADD COLUMN IF NOT EXISTS past_medical_history TEXT,
ADD COLUMN IF NOT EXISTS location VARCHAR(255),
ADD COLUMN IF NOT EXISTS principal_diagnosis TEXT;

-- Create index for visit_id lookup
CREATE INDEX IF NOT EXISTS idx_examination_findings_visit_id ON examination_findings(visit_id);

-- 2. MODIFY TABLE: treatment_plans
-- Add column for visit tracking
ALTER TABLE treatment_plans
ADD COLUMN IF NOT EXISTS visit_id INTEGER REFERENCES visits(visit_id) ON DELETE CASCADE;

-- Create index for visit_id lookup
CREATE INDEX IF NOT EXISTS idx_treatment_plans_visit_id ON treatment_plans(visit_id);
