-- ============================================================================
-- CREATE ADMINS TABLE AND MIGRATE SUPER ADMINS
-- ============================================================================
--
-- Purpose: Separate admin accounts from doctors table into dedicated admins table
-- Run this in: Supabase SQL Editor
-- Date: 2025-10-11
--
-- ============================================================================

-- ============================================================================
-- STEP 1: CREATE ADMINS TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS admins (
  admin_id SERIAL PRIMARY KEY,
  full_name VARCHAR(255) NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  phone VARCHAR(50),
  profile_picture_url VARCHAR(255),
  status VARCHAR(50) DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'suspended')),
  permissions JSONB DEFAULT '{
    "canApproveUsers": true,
    "canManageStaff": true,
    "canManageDoctors": true,
    "canManageWorkers": true,
    "canViewReports": true,
    "canAccessAllPages": true,
    "canManageSettings": true,
    "canManageTreatments": true,
    "canViewAuditLogs": true,
    "canManageBilling": true,
    "canManageClinics": true
  }'::jsonb,
  last_login TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_by INTEGER REFERENCES admins(admin_id) ON DELETE SET NULL
);

-- ============================================================================
-- STEP 2: ADD INDEXES FOR PERFORMANCE
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_admins_email ON admins(email);
CREATE INDEX IF NOT EXISTS idx_admins_status ON admins(status);
CREATE INDEX IF NOT EXISTS idx_admins_created_at ON admins(created_at DESC);

-- ============================================================================
-- STEP 3: ADD AUTO-UPDATE TRIGGER FOR updated_at
-- ============================================================================

-- Check if trigger function exists (it should from your schema)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'update_updated_at_column') THEN
        CREATE OR REPLACE FUNCTION update_updated_at_column()
        RETURNS TRIGGER AS '
        BEGIN
            NEW.updated_at = NOW();
            RETURN NEW;
        END;
        ' LANGUAGE plpgsql;
    END IF;
END $$;

-- Create trigger
DROP TRIGGER IF EXISTS update_admins_updated_at ON admins;
CREATE TRIGGER update_admins_updated_at
    BEFORE UPDATE ON admins
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- STEP 4: MIGRATE EXISTING SUPER ADMINS FROM DOCTORS TABLE
-- ============================================================================

-- Insert super admin doctors into admins table
-- Looking for doctors with email containing 'admin' or name containing 'Super Admin' or 'Administrator'
INSERT INTO admins (full_name, email, password_hash, phone, status, last_login, created_at)
SELECT
  full_name,
  email,
  password_hash,
  NULL as phone, -- doctors table may not have phone
  status,
  last_login,
  created_at
FROM doctors
WHERE
  email IS NOT NULL
  AND (
    LOWER(email) LIKE '%admin%'
    OR LOWER(full_name) LIKE '%super admin%'
    OR LOWER(full_name) LIKE '%administrator%'
  )
  AND NOT EXISTS (
    SELECT 1 FROM admins WHERE admins.email = doctors.email
  );

-- ============================================================================
-- STEP 5: UPDATE AUDIT_LOGS TABLE TO SUPPORT ADMIN USER TYPE
-- ============================================================================

-- Drop existing constraint if it exists
ALTER TABLE IF EXISTS audit_logs DROP CONSTRAINT IF EXISTS check_user_type;
ALTER TABLE IF EXISTS audit_logs DROP CONSTRAINT IF EXISTS audit_logs_user_type_check;

-- Add new constraint with admin support
ALTER TABLE IF EXISTS audit_logs
  ADD CONSTRAINT check_user_type
  CHECK (user_type IN ('doctor', 'worker', 'admin', 'nurse', 'unknown'));

-- ============================================================================
-- STEP 6: UPDATE USER_SESSIONS TABLE TO SUPPORT ADMIN USER TYPE
-- ============================================================================

-- Drop existing constraint if it exists
ALTER TABLE IF EXISTS user_sessions DROP CONSTRAINT IF EXISTS check_session_user_type;
ALTER TABLE IF EXISTS user_sessions DROP CONSTRAINT IF EXISTS user_sessions_user_type_check;

-- Add new constraint with admin support
ALTER TABLE IF EXISTS user_sessions
  ADD CONSTRAINT check_session_user_type
  CHECK (user_type IN ('doctor', 'worker', 'admin', 'nurse'));

-- ============================================================================
-- STEP 7: UPDATE NOTIFICATIONS TABLE TO SUPPORT ADMIN USER TYPE
-- ============================================================================

-- Drop existing constraint if it exists
ALTER TABLE IF EXISTS notifications DROP CONSTRAINT IF EXISTS check_notification_user_type;
ALTER TABLE IF EXISTS notifications DROP CONSTRAINT IF EXISTS notifications_user_type_check;

-- Add new constraint with admin support
ALTER TABLE IF EXISTS notifications
  ADD CONSTRAINT check_notification_user_type
  CHECK (user_type IN ('doctor', 'worker', 'admin', 'nurse'));

-- ============================================================================
-- STEP 8: ADD ADMIN SUPPORT TO PENDING_USERS (IF TABLE EXISTS)
-- ============================================================================

-- Add admin role to pending_users if table exists
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'pending_users') THEN
        -- Drop existing constraint
        ALTER TABLE pending_users DROP CONSTRAINT IF EXISTS check_pending_user_role;
        ALTER TABLE pending_users DROP CONSTRAINT IF EXISTS pending_users_role_check;

        -- Add new constraint with admin support
        ALTER TABLE pending_users
          ADD CONSTRAINT check_pending_user_role
          CHECK (role IN ('doctor', 'worker', 'admin', 'nurse'));

        -- Add column for admin approver if not exists
        ALTER TABLE pending_users ADD COLUMN IF NOT EXISTS approved_by_admin INTEGER REFERENCES admins(admin_id);
    END IF;
END $$;

-- ============================================================================
-- STEP 9: OPTIONAL - CLEAN UP DOCTORS TABLE
-- ============================================================================

-- OPTION A: Keep super admins in doctors table but remove admin flag
-- (They can still function as doctors if needed)
-- UPDATE doctors
-- SET is_super_admin = FALSE
-- WHERE LOWER(email) LIKE '%admin%'
--    OR LOWER(full_name) LIKE '%super admin%'
--    OR LOWER(full_name) LIKE '%administrator%';

-- OPTION B: Remove super admins from doctors table entirely
-- (Use this if admins should NOT be doctors)
-- DELETE FROM doctors
-- WHERE LOWER(email) LIKE '%admin%'
--    OR LOWER(full_name) LIKE '%super admin%'
--    OR LOWER(full_name) LIKE '%administrator%';

-- For now, we'll leave them in both tables (commented out)
-- You can run one of the above commands manually if needed

-- ============================================================================
-- STEP 10: VERIFY MIGRATION
-- ============================================================================

-- Show created admins
DO $$
DECLARE
    admin_count INTEGER;
    doctor_count INTEGER;
    worker_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO admin_count FROM admins;
    SELECT COUNT(*) INTO doctor_count FROM doctors WHERE is_archived = FALSE;
    SELECT COUNT(*) INTO worker_count FROM workers;

    RAISE NOTICE '';
    RAISE NOTICE '╔══════════════════════════════════════════════════════════════╗';
    RAISE NOTICE '║            ✅ MIGRATION COMPLETED SUCCESSFULLY               ║';
    RAISE NOTICE '╚══════════════════════════════════════════════════════════════╝';
    RAISE NOTICE '';
    RAISE NOTICE '📊 User Counts:';
    RAISE NOTICE '   👑 Admins:  % accounts', admin_count;
    RAISE NOTICE '   🩺 Doctors: % accounts', doctor_count;
    RAISE NOTICE '   💼 Workers: % accounts', worker_count;
    RAISE NOTICE '';
    RAISE NOTICE '✅ Tables Updated:';
    RAISE NOTICE '   • admins (created)';
    RAISE NOTICE '   • audit_logs (updated user_type constraint)';
    RAISE NOTICE '   • user_sessions (updated user_type constraint)';
    RAISE NOTICE '   • notifications (updated user_type constraint)';
    RAISE NOTICE '   • pending_users (added admin support)';
    RAISE NOTICE '';
    RAISE NOTICE '📝 Next Steps:';
    RAISE NOTICE '   1. Update backend authentication code';
    RAISE NOTICE '   2. Update frontend to support admin login';
    RAISE NOTICE '   3. Test login with migrated admin accounts';
    RAISE NOTICE '';
END $$;

-- Show migrated admin accounts
SELECT
    admin_id,
    full_name,
    email,
    status,
    created_at,
    '✅ Migrated from doctors table' as note
FROM admins
ORDER BY created_at ASC;

-- ============================================================================
-- DONE!
-- ============================================================================
