/* ===============================================================
   AUTHENTICATION MIDDLEWARE
   Supports three user types: admins, doctors, workers
   =============================================================== */

const pool = require('../db');

/**
 * Authenticate Admin Users
 * Checks user_sessions table for valid admin token
 */
async function authenticateAdmin(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ success: false, error: 'No token provided' });
    }

    const token = authHeader.replace('Bearer ', '');

    // Check session in user_sessions table
    const sessionResult = await pool.query(
      `SELECT us.*, a.admin_id, a.full_name, a.email, a.status, a.permissions
       FROM user_sessions us
       JOIN admins a ON us.user_id = a.admin_id
       WHERE us.token = $1
         AND us.user_type = 'admin'
         AND us.expires_at > NOW()`,
      [token]
    );

    if (sessionResult.rows.length === 0) {
      return res.status(401).json({ success: false, error: 'Invalid or expired token' });
    }

    const session = sessionResult.rows[0];

    // Check if admin is active
    if (session.status !== 'active') {
      return res.status(401).json({ success: false, error: 'Admin account is not active' });
    }

    // Update last activity
    await pool.query(
      'UPDATE user_sessions SET last_activity = NOW() WHERE token = $1',
      [token]
    );

    // Attach user info to request
    req.user = {
      userId: session.admin_id,
      id: session.admin_id,
      userType: 'admin',
      role: 'admin',
      fullName: session.full_name,
      email: session.email,
      permissions: session.permissions || {}
    };

    next();
  } catch (error) {
    console.error('Admin authentication error:', error);
    res.status(500).json({ success: false, error: 'Authentication failed' });
  }
}

/**
 * Authenticate Doctor Users
 * Checks user_sessions table for valid doctor token
 */
async function authenticateDoctor(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ success: false, error: 'No token provided' });
    }

    const token = authHeader.replace('Bearer ', '');

    // Check session
    const sessionResult = await pool.query(
      `SELECT us.*, d.doctor_id, d.full_name, d.email, d.status, d.specialty
       FROM user_sessions us
       JOIN doctors d ON us.user_id = d.doctor_id
       WHERE us.token = $1
         AND us.user_type = 'doctor'
         AND us.expires_at > NOW()
         AND d.is_archived = FALSE`,
      [token]
    );

    if (sessionResult.rows.length === 0) {
      return res.status(401).json({ success: false, error: 'Invalid or expired token' });
    }

    const session = sessionResult.rows[0];

    if (session.status !== 'active') {
      return res.status(401).json({ success: false, error: 'Doctor account is not active' });
    }

    // Update last activity
    await pool.query(
      'UPDATE user_sessions SET last_activity = NOW() WHERE token = $1',
      [token]
    );

    req.user = {
      userId: session.doctor_id,
      id: session.doctor_id,
      userType: 'doctor',
      role: 'doctor',
      fullName: session.full_name,
      email: session.email,
      specialty: session.specialty
    };

    next();
  } catch (error) {
    console.error('Doctor authentication error:', error);
    res.status(500).json({ success: false, error: 'Authentication failed' });
  }
}

/**
 * Authenticate Worker Users
 * Checks user_sessions table for valid worker token
 */
async function authenticateWorker(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ success: false, error: 'No token provided' });
    }

    const token = authHeader.replace('Bearer ', '');

    // Check session
    const sessionResult = await pool.query(
      `SELECT us.*, w.id as worker_id, w.username
       FROM user_sessions us
       JOIN workers w ON us.user_id = w.id
       WHERE us.token = $1
         AND us.user_type IN ('worker', 'nurse')
         AND us.expires_at > NOW()`,
      [token]
    );

    if (sessionResult.rows.length === 0) {
      return res.status(401).json({ success: false, error: 'Invalid or expired token' });
    }

    const session = sessionResult.rows[0];

    // Update last activity
    await pool.query(
      'UPDATE user_sessions SET last_activity = NOW() WHERE token = $1',
      [token]
    );

    req.user = {
      userId: session.worker_id,
      id: session.worker_id,
      userType: 'worker',
      role: 'nurse', // Workers are shown as 'nurse' in UI
      username: session.username
    };

    next();
  } catch (error) {
    console.error('Worker authentication error:', error);
    res.status(500).json({ success: false, error: 'Authentication failed' });
  }
}

/**
 * Authenticate Any User (Admin, Doctor, or Worker)
 * Use this for endpoints accessible by multiple user types
 */
async function authenticateAny(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ success: false, error: 'No token provided' });
    }

    const token = authHeader.replace('Bearer ', '');

    // Check session (any user type)
    const sessionResult = await pool.query(
      `SELECT * FROM user_sessions
       WHERE token = $1 AND expires_at > NOW()`,
      [token]
    );

    if (sessionResult.rows.length === 0) {
      return res.status(401).json({ success: false, error: 'Invalid or expired token' });
    }

    const session = sessionResult.rows[0];

    // Update last activity
    await pool.query(
      'UPDATE user_sessions SET last_activity = NOW() WHERE token = $1',
      [token]
    );

    // Get user details based on type
    let user = null;
    if (session.user_type === 'admin') {
      const result = await pool.query(
        'SELECT admin_id as id, full_name, email, permissions FROM admins WHERE admin_id = $1 AND status = $2',
        [session.user_id, 'active']
      );
      if (result.rows.length > 0) {
        user = { ...result.rows[0], userType: 'admin', role: 'admin' };
      }
    } else if (session.user_type === 'doctor') {
      const result = await pool.query(
        'SELECT doctor_id as id, full_name, email, specialty FROM doctors WHERE doctor_id = $1 AND status = $2 AND is_archived = FALSE',
        [session.user_id, 'active']
      );
      if (result.rows.length > 0) {
        user = { ...result.rows[0], userType: 'doctor', role: 'doctor' };
      }
    } else if (session.user_type === 'worker' || session.user_type === 'nurse') {
      const result = await pool.query(
        'SELECT id, username FROM workers WHERE id = $1',
        [session.user_id]
      );
      if (result.rows.length > 0) {
        user = { ...result.rows[0], userType: 'worker', role: 'nurse' };
      }
    }

    if (!user) {
      return res.status(401).json({ success: false, error: 'User not found or inactive' });
    }

    req.user = {
      userId: user.id,
      id: user.id,
      ...user
    };

    next();
  } catch (error) {
    console.error('Authentication error:', error);
    res.status(500).json({ success: false, error: 'Authentication failed' });
  }
}

/**
 * Check if user has specific permission
 * Use after authentication middleware
 */
function requirePermission(...permissions) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ success: false, error: 'Not authenticated' });
    }

    // Admins have all permissions
    if (req.user.userType === 'admin') {
      return next();
    }

    // Check if user has required permissions
    const userPermissions = req.user.permissions || {};
    const hasPermission = permissions.some(perm => userPermissions[perm] === true);

    if (!hasPermission) {
      return res.status(403).json({
        success: false,
        error: 'Insufficient permissions'
      });
    }

    next();
  };
}

module.exports = {
  authenticateAdmin,
  authenticateDoctor,
  authenticateWorker,
  authenticateAny,
  requirePermission
};
