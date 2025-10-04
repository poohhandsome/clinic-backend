# Database Migrations - Treatment Management System

## 📋 Overview

This folder contains database migrations for the Treatment Management System feature.

## 📦 Migration Files

1. **001_treatment_system.sql** - Creates new tables (treatments, visits, billing, visit_treatments)
2. **002_modify_existing_tables.sql** - Modifies existing tables (examination_findings, treatment_plans)
3. **003_insert_starter_data.sql** - Inserts 19 starter treatment records

## 🚀 How to Run Migrations

### Step 1: Navigate to backend folder
```bash
cd backend
```

### Step 2: Run the migration script
```bash
node migrations/run-migration.js
```

### Expected Output
```
═══════════════════════════════════════════════════════════════════════════
TREATMENT MANAGEMENT SYSTEM - DATABASE MIGRATION
═══════════════════════════════════════════════════════════════════════════

➤ Running migration: 001_treatment_system.sql
✓ Successfully executed: 001_treatment_system.sql

➤ Running migration: 002_modify_existing_tables.sql
✓ Successfully executed: 002_modify_existing_tables.sql

➤ Running migration: 003_insert_starter_data.sql
✓ Successfully executed: 003_insert_starter_data.sql

═══════════════════════════════════════════════════════════════════════════
MIGRATION SUMMARY
═══════════════════════════════════════════════════════════════════════════
Successful: 3
Failed: 0
═══════════════════════════════════════════════════════════════════════════
```

## ✅ What Gets Created

### New Tables
- `treatments` - Master treatment list with codes and prices
- `visits` - Patient queue and visit tracking
- `billing` - Payment records
- `visit_treatments` - Treatments performed during visits

### Modified Tables
- `examination_findings` - Added visit tracking columns
- `treatment_plans` - Added visit tracking column

### Sample Data
- 19 starter treatments across categories:
  - Restorative (fillings)
  - Surgery (extractions)
  - Periodontics (scaling)
  - Endodontics (root canals)
  - Prosthetics (crowns, bridges)
  - Diagnostic (x-rays)
  - Prevention (cleaning, fluoride)
  - Cosmetic (whitening)

## 🔒 Safety Features

- All migrations use `IF NOT EXISTS` - safe to run multiple times
- Foreign key constraints protect data integrity
- Indexes created for query performance
- Starter data uses `ON CONFLICT DO NOTHING` - won't duplicate

## ⚠️ Important Notes

1. Make sure your `.env` file has the correct `DATABASE_URL`
2. Ensure your database has the required existing tables:
   - `patients`
   - `doctors_identities`
   - `clinics`
   - `examination_findings`
   - `treatment_plans`
3. Migrations run in order - if one fails, the rest won't run

## 🔧 Troubleshooting

**Error: "relation does not exist"**
- Your database is missing required tables (patients, doctors_identities, etc.)
- Run your previous schema setup first

**Error: "permission denied"**
- Check your `DATABASE_URL` credentials
- Ensure the database user has CREATE TABLE permissions

**Error: "column already exists"**
- Safe to ignore - migrations use `IF NOT EXISTS`
- Or the migration already ran successfully before

## 📞 Need Help?

If migrations fail, check:
1. Database connection (test with: `node -e "require('./db').query('SELECT 1')"`)
2. Existing table schema
3. Database permissions
