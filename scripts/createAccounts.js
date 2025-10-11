#!/usr/bin/env node

/* ===============================================================
   CLINIC MANAGEMENT SYSTEM - INITIAL ACCOUNT SETUP
   Creates Super Admin and Sample Worker Accounts
   =============================================================== */

const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const readline = require('readline');
require('dotenv').config();

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: process.env.NODE_ENV === 'production'
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

// Color code validation
function validateColor(color) {
  const colorRegex = /^#[0-9A-Fa-f]{6}$/;
  return colorRegex.test(color);
}

// Create Super Admin Doctor Account
async function createSuperAdmin() {
  console.log('\n🔐 SUPER ADMIN ACCOUNT CREATION');
  console.log('━'.repeat(70));
  console.log('This will create a doctor account with FULL system access.');
  console.log('Super admins can access ALL pages and manage ALL settings.\n');

  const createAdmin = await question('Create Super Admin account? (y/n): ');
  if (createAdmin.toLowerCase() !== 'y') {
    console.log('⏭️  Skipping super admin creation\n');
    return null;
  }

  // Collect inputs with defaults
  let fullName = await question('Full name [Super Admin]: ');
  fullName = fullName.trim() || 'Super Admin';

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

  let specialty = await question('Specialty [Administrator]: ');
  specialty = specialty.trim() || 'Administrator';

  let color = await question('Color code [#FF6B6B]: ');
  color = color.trim() || '#FF6B6B';

  if (!validateColor(color)) {
    console.log('❌ Invalid color code. Using default #FF6B6B');
    color = '#FF6B6B';
  }

  try {
    // Check if email already exists
    const existing = await pool.query(
      'SELECT doctor_id, full_name, email FROM doctors WHERE email = $1',
      [email]
    );

    if (existing.rows.length > 0) {
      console.log('\n⚠️  A doctor account already exists with this email:');
      console.log('   ID:', existing.rows[0].doctor_id);
      console.log('   Name:', existing.rows[0].full_name);
      console.log('   Email:', existing.rows[0].email);
      console.log('\n   Skipping creation to prevent duplicates.\n');
      return null;
    }

    // Hash password
    console.log('\n🔄 Hashing password...');
    const passwordHash = await bcrypt.hash(password, 10);

    // Create super admin doctor
    console.log('🔄 Creating super admin account...');

    // Check if permissions column exists, if not use simpler insert
    let insertQuery;
    let insertParams;

    try {
      insertQuery = `
        INSERT INTO doctors
        (full_name, email, password_hash, specialty, color, status)
        VALUES ($1, $2, $3, $4, $5, 'active')
        RETURNING doctor_id
      `;
      insertParams = [fullName, email, passwordHash, specialty, color];

      const result = await pool.query(insertQuery, insertParams);
      const doctorId = result.rows[0].doctor_id;

      // Assign to clinic 1
      console.log('🔄 Assigning to clinic...');
      await pool.query(
        'INSERT INTO doctor_clinic_assignments (doctor_id, clinic_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [doctorId, 1]
      );

      console.log('\n✅ SUPER ADMIN CREATED SUCCESSFULLY!');
      console.log('━'.repeat(70));
      console.log('🆔 Doctor ID:', doctorId);
      console.log('👤 Name:', fullName);
      console.log('📧 Email:', email);
      console.log('🔑 Password:', password);
      console.log('🎨 Color:', color);
      console.log('⚡ Specialty:', specialty);
      console.log('🏥 Clinic:', 'Clinic 1 (Default)');
      console.log('🔓 Permissions: FULL ACCESS (Doctor Dashboard + Admin Features)');
      console.log('━'.repeat(70));

      return {
        id: doctorId,
        type: 'super_admin',
        name: fullName,
        email: email,
        password: password,
        specialty: specialty,
        color: color
      };

    } catch (error) {
      console.error('❌ Error creating super admin:', error.message);
      return null;
    }

  } catch (error) {
    console.error('❌ Error in super admin creation:', error.message);
    return null;
  }
}

// Create Sample Worker Account
async function createWorker() {
  console.log('\n👔 WORKER ACCOUNT CREATION');
  console.log('━'.repeat(70));
  console.log('This will create a worker account for counter/reception staff.');
  console.log('Workers have limited access (counter page only).\n');

  const createWork = await question('Create sample worker account? (y/n): ');
  if (createWork.toLowerCase() !== 'y') {
    console.log('⏭️  Skipping worker creation\n');
    return null;
  }

  let username = await question('Username [counter]: ');
  username = username.trim() || 'counter';

  let password = await question('Password [Counter@2025]: ');
  password = password.trim() || 'Counter@2025';

  const passwordCheck = validatePassword(password);
  if (!passwordCheck.valid) {
    console.log('❌', passwordCheck.error);
    return null;
  }

  try {
    // Check if username already exists
    const existing = await pool.query(
      'SELECT id, username FROM workers WHERE username = $1',
      [username]
    );

    if (existing.rows.length > 0) {
      console.log('\n⚠️  A worker account already exists with this username:');
      console.log('   ID:', existing.rows[0].id);
      console.log('   Username:', existing.rows[0].username);
      console.log('\n   Skipping creation to prevent duplicates.\n');
      return null;
    }

    // Hash password
    console.log('\n🔄 Hashing password...');
    const passwordHash = await bcrypt.hash(password, 10);

    // Create worker
    console.log('🔄 Creating worker account...');
    const result = await pool.query(
      'INSERT INTO workers (username, password_hash) VALUES ($1, $2) RETURNING id',
      [username, passwordHash]
    );

    const workerId = result.rows[0].id;

    console.log('\n✅ WORKER CREATED SUCCESSFULLY!');
    console.log('━'.repeat(70));
    console.log('🆔 Worker ID:', workerId);
    console.log('👤 Username:', username);
    console.log('🔑 Password:', password);
    console.log('🔓 Access Level: Counter/Reception Page Only');
    console.log('━'.repeat(70));

    return {
      id: workerId,
      type: 'worker',
      username: username,
      password: password
    };

  } catch (error) {
    console.error('❌ Error creating worker:', error.message);
    return null;
  }
}

// Main execution
async function main() {
  console.log('\n╔════════════════════════════════════════════════════════════════════╗');
  console.log('║                 CLINIC MANAGEMENT SYSTEM                           ║');
  console.log('║                 Initial Account Setup Script                       ║');
  console.log('╚════════════════════════════════════════════════════════════════════╝');

  const createdAccounts = [];

  try {
    // Test database connection
    console.log('\n🔄 Testing database connection...');
    await pool.query('SELECT NOW()');
    console.log('✅ Database connected successfully!');

    // Create accounts
    const superAdmin = await createSuperAdmin();
    if (superAdmin) {
      createdAccounts.push(superAdmin);
    }

    const worker = await createWorker();
    if (worker) {
      createdAccounts.push(worker);
    }

    // Summary
    if (createdAccounts.length > 0) {
      console.log('\n╔════════════════════════════════════════════════════════════════════╗');
      console.log('║                    ✅ SETUP COMPLETE!                              ║');
      console.log('╚════════════════════════════════════════════════════════════════════╝');

      console.log('\n📋 CREATED ACCOUNTS SUMMARY:');
      console.log('━'.repeat(70));

      createdAccounts.forEach((account, index) => {
        console.log(`\n${index + 1}. ${account.type.toUpperCase()}`);
        if (account.type === 'super_admin') {
          console.log(`   🆔 ID: ${account.id}`);
          console.log(`   👤 Name: ${account.name}`);
          console.log(`   📧 Email: ${account.email}`);
          console.log(`   🔑 Password: ${account.password}`);
          console.log(`   ⚡ Specialty: ${account.specialty}`);
          console.log(`   🎨 Color: ${account.color}`);
          console.log(`   🔓 Access: FULL SYSTEM ACCESS`);
        } else {
          console.log(`   🆔 ID: ${account.id}`);
          console.log(`   👤 Username: ${account.username}`);
          console.log(`   🔑 Password: ${account.password}`);
          console.log(`   🔓 Access: Counter Page Only`);
        }
      });

      console.log('\n━'.repeat(70));
      console.log('\n📝 IMPORTANT SECURITY NOTES:');
      console.log('   • 🔐 Save these credentials in a secure location');
      console.log('   • 🔄 Change default passwords after first login');
      console.log('   • 🚫 Do NOT share credentials via insecure channels');
      console.log('   • ✅ Super admin can access ALL pages and features');
      console.log('   • 📊 Workers have limited access to counter operations only');

      console.log('\n🚀 NEXT STEPS:');
      console.log('   1. Go to your frontend application');
      console.log('   2. Login with the credentials above');
      console.log('   3. Change passwords immediately');
      console.log('   4. Configure additional settings as needed');

      console.log('\n✨ Your clinic management system is ready to use!\n');

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
