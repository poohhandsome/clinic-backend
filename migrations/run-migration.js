// ═══════════════════════════════════════════════════════════════════════════
// MIGRATION RUNNER SCRIPT
// Usage: node migrations/run-migration.js
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
require('dotenv').config();

// Create database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: process.env.NODE_ENV === 'production' ? true : false
  }
});

// ANSI color codes for terminal output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m'
};

// Migration files in order
const migrations = [
  '001_treatment_system.sql',
  '002_modify_existing_tables.sql',
  '003_insert_starter_data.sql'
];

async function runMigration(filename) {
  const filePath = path.join(__dirname, filename);

  console.log(`${colors.blue}➤${colors.reset} Running migration: ${colors.cyan}${filename}${colors.reset}`);

  try {
    // Read SQL file
    const sql = fs.readFileSync(filePath, 'utf8');

    // Execute SQL
    await pool.query(sql);

    console.log(`${colors.green}✓${colors.reset} Successfully executed: ${filename}\n`);
    return true;
  } catch (error) {
    console.error(`${colors.red}✗${colors.reset} Failed to execute: ${filename}`);
    console.error(`${colors.red}Error:${colors.reset}`, error.message);
    console.error(`${colors.yellow}Details:${colors.reset}`, error.detail || '');
    return false;
  }
}

async function runAllMigrations() {
  console.log(`\n${'═'.repeat(80)}`);
  console.log(`${colors.cyan}TREATMENT MANAGEMENT SYSTEM - DATABASE MIGRATION${colors.reset}`);
  console.log(`${'═'.repeat(80)}\n`);

  let successCount = 0;
  let failCount = 0;

  for (const migration of migrations) {
    const success = await runMigration(migration);
    if (success) {
      successCount++;
    } else {
      failCount++;
      console.log(`\n${colors.red}Migration failed. Stopping here.${colors.reset}\n`);
      break;
    }
  }

  console.log(`${'═'.repeat(80)}`);
  console.log(`${colors.cyan}MIGRATION SUMMARY${colors.reset}`);
  console.log(`${'═'.repeat(80)}`);
  console.log(`${colors.green}Successful:${colors.reset} ${successCount}`);
  console.log(`${colors.red}Failed:${colors.reset} ${failCount}`);
  console.log(`${'═'.repeat(80)}\n`);

  // Close database connection
  await pool.end();

  // Exit with appropriate code
  process.exit(failCount > 0 ? 1 : 0);
}

// Run migrations
runAllMigrations().catch(error => {
  console.error(`${colors.red}Fatal error:${colors.reset}`, error);
  pool.end();
  process.exit(1);
});
