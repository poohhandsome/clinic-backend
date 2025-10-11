# Account Creation Script

This script creates initial accounts for the Clinic Management System.

## Features

- ✅ Create Super Admin Doctor account with full system access
- ✅ Create Sample Worker account for counter/reception
- ✅ Interactive CLI with defaults
- ✅ Password validation (strength requirements)
- ✅ Email validation
- ✅ Duplicate prevention
- ✅ Secure password hashing with bcrypt
- ✅ Clear success/error messages

## Requirements

- Node.js installed
- PostgreSQL database configured
- `.env` file with `DATABASE_URL`
- `bcrypt` package installed (already in dependencies)

## How to Run

### Method 1: Using npm script (Recommended)
```bash
cd backend
npm run create-accounts
```

### Method 2: Direct execution
```bash
cd backend
node scripts/createAccounts.js
```

## Usage Flow

1. **Start the script**
   - The script will test the database connection first

2. **Create Super Admin**
   - Answer `y` to create a super admin account
   - Provide details or press Enter for defaults:
     - Full name: `Super Admin`
     - Email: `admin@clinic.com`
     - Password: `Admin@2025`
     - Specialty: `Administrator`
     - Color: `#FF6B6B`

3. **Create Worker**
   - Answer `y` to create a worker account
   - Provide details or press Enter for defaults:
     - Username: `counter`
     - Password: `Counter@2025`

4. **Review Summary**
   - The script will display all created accounts with credentials
   - Save these credentials securely!

## Default Credentials

### Super Admin (Doctor)
- **Email**: `admin@clinic.com`
- **Password**: `Admin@2025`
- **Access**: Full system access (all pages)
- **Type**: Doctor account with admin privileges

### Worker (Counter Staff)
- **Username**: `counter`
- **Password**: `Counter@2025`
- **Access**: Counter/reception page only
- **Type**: Worker account

## Password Requirements

All passwords must meet these criteria:
- ✅ Minimum 8 characters
- ✅ At least one uppercase letter (A-Z)
- ✅ At least one lowercase letter (a-z)
- ✅ At least one number (0-9)
- ✅ At least one special character (!@#$%^&*...)

## Examples

### Using all defaults (quickest)
```bash
npm run create-accounts
```
Then press `y` and `Enter` for all prompts to use defaults.

### Custom super admin
```bash
npm run create-accounts
```
Answer `y` to create super admin, then:
- Full name: `Dr. John Smith`
- Email: `john.smith@clinic.com`
- Password: `MySecure@Pass2025`
- Specialty: `Dentistry`
- Color: `#4A90E2`

## Security Notes

⚠️ **IMPORTANT**:
- Change default passwords immediately after first login
- Store credentials securely (password manager recommended)
- Do NOT commit credentials to version control
- Do NOT share credentials via insecure channels (email, chat)
- Use strong, unique passwords in production

## Troubleshooting

### Error: Cannot connect to database
- Check `DATABASE_URL` in your `.env` file
- Verify database is running and accessible
- Check network connectivity

### Error: Table does not exist
- Run database migrations first
- Ensure `doctors` and `workers` tables exist

### Error: Duplicate email/username
- An account with that email/username already exists
- Use a different email/username or skip creation

### Error: Invalid password
- Check password meets all requirements
- Must have uppercase, lowercase, number, special character
- Minimum 8 characters

## What the Script Does

1. **Validates Inputs**
   - Email format
   - Password strength
   - Color code format

2. **Checks for Duplicates**
   - Queries database for existing email/username
   - Prevents duplicate accounts
   - Shows existing account info if found

3. **Creates Accounts**
   - Hashes passwords with bcrypt (10 rounds)
   - Inserts into `doctors` or `workers` table
   - Assigns super admin to clinic 1

4. **Provides Summary**
   - Lists all created accounts
   - Displays credentials clearly
   - Shows access levels

## Database Tables Used

### doctors
- `doctor_id` (primary key)
- `full_name`
- `email` (unique)
- `password_hash`
- `specialty`
- `color`
- `status` (set to 'active')

### workers
- `id` (primary key)
- `username` (unique)
- `password_hash`

### doctor_clinic_assignments
- `doctor_id` (foreign key)
- `clinic_id` (defaults to 1)

## Support

If you encounter issues:
1. Check the error message carefully
2. Verify database connection
3. Ensure all required tables exist
4. Check the console output for details

## License

Internal use only - Clinic Management System
