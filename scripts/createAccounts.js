#!/usr/bin/env node

/* ===============================================================
   CLINIC MANAGEMENT SYSTEM - ADMIN ACCOUNT SETUP
   Creates System Administrator Accounts
   =============================================================== */

const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const readline = require('readline');
require('dotenv').config();

// Database connection - Supabase compatible SSL settings
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false // Set to false for Supabase to avoid certificate issues
  }
});

// CLI interface
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// Helper function to ask questions
function question(query) {
  return new Promise(resolve => rl.question(query, resolve));
}

// Password validation
function validatePassword(password) {
  const minLength = 8;
  const hasUppercase = /[A-Z]/.test(password);
  const hasLowercase = /[a-z]/.test(password);
  const hasNumber = /[0-9]/.test(password);
  const hasSpecial = /[!@#$%^&*(),.?":{}|<>]/.test(password);

  if (password.length < minLength) {
    return { valid: false, error: 'Password must be at least 8 characters' };
  }
  if (!hasUppercase) {
    return { valid: false, error: 'Password must contain at least one uppercase letter' };
  }
  if (!hasLowercase) {
    return { valid: false, error: 'Password must contain at least one lowercase letter' };
  }
  if (!hasNumber) {
    return { valid: false, error: 'Password must contain at least one number' };
  }
  if (!hasSpecial) {
    return { valid: false, error: 'Password must contain at least one special character (!@#$%^&*...)' };
  }

  return { valid: true };
}

// Email validation
function validateEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

// Create Admin Account
async function createAdmin() {
  console.log('\n👑 ADMIN ACCOUNT CREATION');
  console.log('━'.repeat(70));
  console.log('This will create a system administrator account.');
  console.log('Admins have FULL system access and can manage all users.\n');
  console.log('ℹ️  Note: Doctors and workers should be created through the application.\n');

  // Collect inputs with defaults
  let fullName = await question('Full name [System Administrator]: ');
  fullName = fullName.trim() || 'System Administrator';

  let email = await question('Email [admin@clinic.com]: ');
  email = email.trim() || 'admin@clinic.com';

  if (!validateEmail(email)) {
    console.log('❌ Invalid email format');
    return null;
  }

  let password = await question('Password [Admin@2025]: ');
  password = password.trim() || 'Admin@2025';

  const passwordCheck = validatePassword(password);
  if (!passwordCheck.valid) {
    console.log('❌', passwordCheck.error);
    return null;
  }

  let phone = await question('Phone number (optional): ');
  phone = phone.trim() || null;

  try {
    // Check if email already exists in admins table
    const existing = await pool.query(
      'SELECT admin_id, full_name, email FROM admins WHERE email = $1',
      [email]
    );

    if (existing.rows.length > 0) {
      console.log('\n⚠️  An admin account already exists with this email:');
      console.log('   ID:', existing.rows[0].admin_id);
      console.log('   Name:', existing.rows[0].full_name);
      console.log('   Email:', existing.rows[0].email);
      console.log('\n   Skipping creation to prevent duplicates.\n');
      return null;
    }

    // Hash password
    console.log('\n🔄 Hashing password...');
    const passwordHash = await bcrypt.hash(password, 10);

    // Create admin account
    console.log('🔄 Creating admin account...');

    const defaultPermissions = {
      canApproveUsers: true,
      canManageStaff: true,
      canManageDoctors: true,
      canManageWorkers: true,
      canViewReports: true,
      canAccessAllPages: true,
      canManageSettings: true,
      canManageTreatments: true,
      canViewAuditLogs: true,
      canManageBilling: true,
      canManageClinics: true
    };

    const result = await pool.query(
      `INSERT INTO admins (full_name, email, password_hash, phone, permissions)
       VALUES ($1, $2, $3, $4, $5) RETURNING admin_id`,
      [fullName, email, passwordHash, phone, JSON.stringify(defaultPermissions)]
    );

    const adminId = result.rows[0].admin_id;

    console.log('\n✅ ADMIN CREATED SUCCESSFULLY!');
    console.log('━'.repeat(70));
    console.log('🆔 Admin ID:', adminId);
    console.log('👤 Name:', fullName);
    console.log('📧 Email:', email);
    console.log('🔑 Password:', password);
    if (phone) console.log('📱 Phone:', phone);
    console.log('🔓 Permissions: FULL SYSTEM ACCESS');
    console.log('📊 Can manage: Doctors, Workers, Admins, Settings, Reports');
    console.log('━'.repeat(70));

    return {
      id: adminId,
      type: 'admin',
      name: fullName,
      email: email,
      password: password,
      phone: phone
    };

  } catch (error) {
    console.error('❌ Error creating admin:', error.message);
    if (error.message.includes('relation "admins" does not exist')) {
      console.error('\n⚠️  The admins table does not exist yet.');
      console.error('   Please run the SQL migration first:');
      console.error('   backend/migrations/create_admins_table.sql\n');
    }
    return null;
  }
}

// This function is removed - workers should be created through the application, not this script

// Main execution
async function main() {
  console.log('\n╔════════════════════════════════════════════════════════════════════╗');
  console.log('║                 CLINIC MANAGEMENT SYSTEM                           ║');
  console.log('║             System Administrator Account Setup                     ║');
  console.log('╚════════════════════════════════════════════════════════════════════╝');

  const createdAccounts = [];

  try {
    // Test database connection
    console.log('\n🔄 Testing database connection...');
    await pool.query('SELECT NOW()');
    console.log('✅ Database connected successfully!');

    // Create admin account (can create multiple if needed)
    let createMore = true;
    while (createMore) {
      const admin = await createAdmin();
      if (admin) {
        createdAccounts.push(admin);
      }

      const continueCreating = await question('\nCreate another admin account? (y/n): ');
      createMore = continueCreating.toLowerCase() === 'y';
    }

    // Summary
    if (createdAccounts.length > 0) {
      console.log('\n╔════════════════════════════════════════════════════════════════════╗');
      console.log('║                    ✅ SETUP COMPLETE!                              ║');
      console.log('╚════════════════════════════════════════════════════════════════════╝');

      console.log('\n📋 CREATED ADMIN ACCOUNTS:');
      console.log('━'.repeat(70));

      createdAccounts.forEach((account, index) => {
        console.log(`\n${index + 1}. ADMIN ACCOUNT`);
        console.log(`   🆔 ID: ${account.id}`);
        console.log(`   👤 Name: ${account.name}`);
        console.log(`   📧 Email: ${account.email}`);
        console.log(`   🔑 Password: ${account.password}`);
        if (account.phone) console.log(`   📱 Phone: ${account.phone}`);
        console.log(`   🔓 Access: FULL SYSTEM ACCESS`);
      });

      console.log('\n━'.repeat(70));
      console.log('\n📝 IMPORTANT SECURITY NOTES:');
      console.log('   • 🔐 Save these credentials in a secure location');
      console.log('   • 🔄 Change default passwords after first login');
      console.log('   • 🚫 Do NOT share credentials via insecure channels');
      console.log('   • ✅ Admins can access ALL pages and manage all users');
      console.log('   • 👨‍⚕️ Create doctors through the application, not this script');
      console.log('   • 👔 Create workers through the application, not this script');

      console.log('\n🚀 NEXT STEPS:');
      console.log('   1. Go to your frontend application');
      console.log('   2. Login with the admin credentials above');
      console.log('   3. Change password immediately after first login');
      console.log('   4. Create doctors and workers through the application');
      console.log('   5. Configure clinic settings as needed');

      console.log('\n✨ Your admin account is ready to use!\n');

    } else {
      console.log('\n⚠️  No accounts were created.');
      console.log('   Either accounts already exist or creation was cancelled.\n');
    }

  } catch (error) {
    console.error('\n❌ FATAL ERROR:', error.message);
    console.error('\nPlease check:');
    console.error('   • Database connection (DATABASE_URL in .env)');
    console.error('   • Database tables exist (run migrations first)');
    console.error('   • Network connectivity to database');
    console.error('   • Database credentials are correct\n');
  } finally {
    rl.close();
    await pool.end();
    console.log('👋 Goodbye!\n');
  }
}

// Run the script
main().catch(error => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
