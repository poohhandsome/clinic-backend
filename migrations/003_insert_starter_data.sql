-- ═══════════════════════════════════════════════════════════════════════════
-- TREATMENT MANAGEMENT SYSTEM - STARTER DATA
-- Migration: 003_insert_starter_data.sql
-- ═══════════════════════════════════════════════════════════════════════════

-- Insert starter treatment data
-- Using ON CONFLICT to make this migration idempotent (safe to run multiple times)

INSERT INTO treatments (code, name, standard_price, category, description) VALUES
('DF001', 'Dental Filling - Amalgam', 800.00, 'Restorative', 'Silver amalgam filling for cavities'),
('DF002', 'Dental Filling - Composite', 1200.00, 'Restorative', 'Tooth-colored composite resin filling'),
('DF003', 'Dental Filling - Glass Ionomer', 1000.00, 'Restorative', 'Glass ionomer cement filling'),
('EX001', 'Simple Extraction', 1500.00, 'Surgery', 'Basic tooth extraction'),
('EX002', 'Surgical Extraction', 3500.00, 'Surgery', 'Surgical removal of tooth'),
('EX003', 'Impacted Tooth Extraction', 5000.00, 'Surgery', 'Removal of impacted wisdom tooth'),
('SRP001', 'Scaling and Root Planing (Per Quadrant)', 1800.00, 'Periodontics', 'Deep cleaning per quadrant'),
('SRP002', 'Full Mouth Scaling', 3000.00, 'Periodontics', 'Complete mouth deep cleaning'),
('SC001', 'Dental Scaling (Cleaning)', 800.00, 'Prevention', 'Regular dental cleaning'),
('RC001', 'Root Canal Treatment - Anterior', 4000.00, 'Endodontics', 'Root canal for front teeth'),
('RC002', 'Root Canal Treatment - Premolar', 5000.00, 'Endodontics', 'Root canal for premolar teeth'),
('RC003', 'Root Canal Treatment - Molar', 6500.00, 'Endodontics', 'Root canal for molar teeth'),
('CR001', 'Dental Crown - Porcelain', 8000.00, 'Prosthetics', 'Porcelain dental crown'),
('CR002', 'Dental Crown - Metal', 5000.00, 'Prosthetics', 'Metal dental crown'),
('BR001', 'Dental Bridge (Per Unit)', 7000.00, 'Prosthetics', 'Fixed dental bridge per unit'),
('XR001', 'Panoramic X-Ray', 800.00, 'Diagnostic', 'Full mouth panoramic radiograph'),
('XR002', 'Periapical X-Ray', 300.00, 'Diagnostic', 'Single tooth x-ray'),
('FL001', 'Fluoride Treatment', 500.00, 'Prevention', 'Fluoride varnish application'),
('WH001', 'Teeth Whitening', 5000.00, 'Cosmetic', 'Professional teeth whitening treatment')
ON CONFLICT (code) DO NOTHING;
