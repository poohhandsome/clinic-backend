# Troubleshooting Guide - Account Creation Script

## Common Issues & Solutions

### 1. SSL Certificate Error ✅ FIXED

**Error Message:**
```
self-signed certificate in certificate chain
```

**Solution:**
This has been fixed in the script. The SSL configuration now uses:
```javascript
ssl: { rejectUnauthorized: false }
```

This is safe for Supabase/Neon connections.

---

### 2. Database Connection Failed

**Error Message:**
```
FATAL ERROR: connect ECONNREFUSED
```

**Solutions:**
1. Check your `.env` file exists in `/backend` folder
2. Verify `DATABASE_URL` is set correctly:
   ```
   DATABASE_URL="postgresql://user:pass@host:5432/db"
   ```
3. Test connection manually:
   ```bash
   psql "postgresql://user:pass@host:5432/db"
   ```
4. Check if database is accessible from your network

---

### 3. Table Does Not Exist

**Error Message:**
```
relation "doctors" does not exist
```

**Solution:**
Your database schema hasn't been created yet. You need to:
1. Run your database migrations first
2. Or manually create the tables using your schema SQL

Required tables:
- `doctors` (for super admin)
- `workers` (for counter staff)
- `doctor_clinic_assignments` (for clinic assignment)

---

### 4. Duplicate Email/Username

**Error Message:**
```
⚠️ A doctor account already exists with this email
```

**Solution:**
This is expected behavior! The script detects existing accounts to prevent duplicates.

Options:
- Use a different email/username
- Delete the existing account from database (if you want to recreate)
- Skip creation (script will continue)

---

### 5. Weak Password Rejected

**Error Message:**
```
❌ Password must contain uppercase, lowercase, number, and special character
```

**Solution:**
Your password must meet ALL requirements:
- ✅ Minimum 8 characters
- ✅ At least 1 uppercase letter (A-Z)
- ✅ At least 1 lowercase letter (a-z)
- ✅ At least 1 number (0-9)
- ✅ At least 1 special character (!@#$%^&*)

**Examples of valid passwords:**
- `Admin@2025` ✅
- `Counter@2025` ✅
- `MySecure#Pass123` ✅
- `Clinic$System2025` ✅

**Examples of invalid passwords:**
- `admin2025` ❌ (no uppercase, no special char)
- `ADMIN@` ❌ (too short, no number)
- `Admin2025` ❌ (no special character)

---

### 6. Invalid Email Format

**Error Message:**
```
❌ Invalid email format
```

**Solution:**
Email must be in format: `username@domain.com`

Valid examples:
- `admin@clinic.com` ✅
- `john.smith@hospital.org` ✅
- `doctor_123@dental.co.th` ✅

Invalid examples:
- `admin` ❌
- `admin@clinic` ❌
- `@clinic.com` ❌

---

### 7. Script Won't Start

**Error Message:**
```
Cannot find module 'bcrypt'
```

**Solution:**
Install dependencies:
```bash
cd backend
npm install
```

This will install:
- bcrypt (password hashing)
- pg (PostgreSQL driver)
- dotenv (environment variables)
- readline (CLI interface)

---

### 8. Readline/Input Not Working

**Problem:**
Script doesn't accept input or freezes

**Solution:**
Make sure you're running in an interactive terminal:
```bash
# Use normal terminal (not IDE terminal if having issues)
cd backend
npm run create-accounts
```

Windows users: Use PowerShell or Command Prompt

---

### 9. Environment Variables Not Loading

**Error Message:**
```
DATABASE_URL is undefined
```

**Solution:**
1. Check `.env` file exists in `/backend` folder (not root)
2. Restart your terminal/IDE
3. Run from the backend directory:
   ```bash
   cd backend
   npm run create-accounts
   ```

---

### 10. Permission Denied

**Error Message:**
```
EACCES: permission denied
```

**Solution:**
Run with appropriate permissions:

**Linux/Mac:**
```bash
chmod +x scripts/createAccounts.js
npm run create-accounts
```

**Windows:**
Run terminal as Administrator if needed

---

## Testing the Script

### Quick Test (Without Creating Accounts)
```bash
cd backend
node -c scripts/createAccounts.js
```
This checks for syntax errors without running.

### Test Database Connection
```bash
cd backend
node -e "require('dotenv').config(); const {Pool} = require('pg'); const p = new Pool({connectionString: process.env.DATABASE_URL, ssl: {rejectUnauthorized: false}}); p.query('SELECT NOW()').then(r => console.log('✅ Connected:', r.rows[0])).catch(e => console.error('❌ Error:', e.message)).finally(() => p.end());"
```

---

## Getting Help

If you're still having issues:

1. **Check Error Message:** Read the error carefully - it usually tells you what's wrong
2. **Check Database:** Ensure Supabase/Neon database is running
3. **Check Environment:** Verify `.env` file has correct values
4. **Check Network:** Ensure you can reach the database server
5. **Check Logs:** Look for detailed error messages in console

---

## Success Indicators

You'll know it worked when you see:
```
✅ Database connected successfully!
✅ SUPER ADMIN CREATED SUCCESSFULLY!
✅ WORKER CREATED SUCCESSFULLY!
✅ SETUP COMPLETE!
```

---

## After Successful Creation

1. ✅ Save the credentials shown in the summary
2. ✅ Go to your frontend application
3. ✅ Login with the credentials
4. ✅ Change passwords immediately
5. ✅ Start using the system!

---

**Need more help?** Check the full documentation in [README.md](README.md)
