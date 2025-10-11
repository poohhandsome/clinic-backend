/* ===============================================================
   ENHANCED AUTHENTICATION ROUTES
   Supports three user types: admins, doctors, workers
   =============================================================== */

const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const pool = require('../db');
const { logAudit } = require('../utils/audit');

/**
 * Enhanced Login Endpoint
 * Supports three user types: admin, doctor, worker
 * POST /api/auth/login
 */
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    // Input validation
    if (!username || !password) {
      return res.status(400).json({
        success: false,
        error: 'Username/email and password are required'
      });
    }

    if (typeof username !== 'string' || typeof password !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Invalid input format'
      });
    }

    const trimmedUsername = username.trim();

    if (trimmedUsername.length === 0 || password.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Username/email and password cannot be empty'
      });
    }

    let user = null;
    let userType = null;
    let idColumn = null;
    let tableName = null;

    // STEP 1: Check if it's an email (admins and doctors use email)
    const isEmail = trimmedUsername.includes('@');

    if (isEmail) {
      // Check admins table first (highest priority)
      const adminResult = await pool.query(
        'SELECT * FROM admins WHERE email = $1 AND status = $2',
        [trimmedUsername, 'active']
      );

      if (adminResult.rows.length > 0) {
        user = adminResult.rows[0];
        userType = 'admin';
        idColumn = 'admin_id';
        tableName = 'admins';
      } else {
        // Check doctors table
        const doctorResult = await pool.query(
          'SELECT * FROM doctors WHERE email = $1 AND status = $2 AND is_archived = FALSE',
          [trimmedUsername, 'active']
        );

        if (doctorResult.rows.length > 0) {
          user = doctorResult.rows[0];
          userType = 'doctor';
          idColumn = 'doctor_id';
          tableName = 'doctors';
        }
      }
    } else {
      // It's a username - check workers table
      const workerResult = await pool.query(
        'SELECT * FROM workers WHERE username = $1',
        [trimmedUsername]
      );

      if (workerResult.rows.length > 0) {
        user = workerResult.rows[0];
        userType = 'worker';
        idColumn = 'id';
        tableName = 'workers';
      }
    }

    // User not found
    if (!user) {
      return res.status(401).json({
        success: false,
        error: 'Invalid credentials'
      });
    }

    // Verify password
    const isValidPassword = await bcrypt.compare(password, user.password_hash);

    if (!isValidPassword) {
      // Log failed attempt
      await logAudit(
        user[idColumn],
        userType,
        'failed_login',
        tableName,
        user[idColumn],
        null,
        { reason: 'invalid_password' },
        req
      );

      return res.status(401).json({
        success: false,
        error: 'Invalid credentials'
      });
    }

    // Generate session token
    const sessionToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    // Create session in user_sessions table
    await pool.query(
      `INSERT INTO user_sessions (user_id, user_type, token, ip_address, user_agent, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        user[idColumn],
        userType,
        sessionToken,
        req.ip || req.connection?.remoteAddress || 'unknown',
        req.headers['user-agent'] || 'unknown',
        expiresAt
      ]
    );

    // Update last_login
    if (tableName !== 'workers') {
      await pool.query(
        `UPDATE ${tableName} SET last_login = NOW() WHERE ${idColumn} = $1`,
        [user[idColumn]]
      );
    }

    // Log successful login
    await logAudit(
      user[idColumn],
      userType,
      'login',
      tableName,
      user[idColumn],
      null,
      { success: true },
      req
    );

    // Prepare response data
    const responseData = {
      userId: user[idColumn],
      userType: userType,
      fullName: user.full_name || user.username || trimmedUsername,
      email: user.email || null,
      username: user.username || null,
      token: sessionToken,
      expiresAt: expiresAt.toISOString(),
      permissions: user.permissions || null,
      specialty: user.specialty || null
    };

    res.json({
      success: true,
      data: responseData
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({
      success: false,
      error: 'Login failed. Please try again later.'
    });
  }
});

/**
 * Logout Endpoint
 * Invalidates the current session
 * POST /api/auth/logout
 */
router.post('/logout', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      return res.status(200).json({
        success: true,
        message: 'Already logged out'
      });
    }

    const token = authHeader.replace('Bearer ', '');

    // Delete session
    const result = await pool.query(
      'DELETE FROM user_sessions WHERE token = $1 RETURNING user_id, user_type',
      [token]
    );

    if (result.rows.length > 0) {
      const { user_id, user_type } = result.rows[0];

      // Log logout
      await logAudit(
        user_id,
        user_type,
        'logout',
        'user_sessions',
        user_id,
        null,
        null,
        req
      );
    }

    res.json({
      success: true,
      message: 'Logged out successfully'
    });

  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({
      success: false,
      error: 'Logout failed'
    });
  }
});

/**
 * Get Current User
 * Returns the currently authenticated user's information
 * GET /api/auth/me
 */
router.get('/me', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      return res.status(401).json({
        success: false,
        error: 'No token provided'
      });
    }

    const token = authHeader.replace('Bearer ', '');

    // Get session
    const sessionResult = await pool.query(
      'SELECT * FROM user_sessions WHERE token = $1 AND expires_at > NOW()',
      [token]
    );

    if (sessionResult.rows.length === 0) {
      return res.status(401).json({
        success: false,
        error: 'Invalid or expired token'
      });
    }

    const session = sessionResult.rows[0];

    // Get user based on type
    let user = null;
    if (session.user_type === 'admin') {
      const result = await pool.query(
        'SELECT admin_id, full_name, email, phone, permissions, status FROM admins WHERE admin_id = $1',
        [session.user_id]
      );
      user = result.rows[0];
      if (user) user.id = user.admin_id;
    } else if (session.user_type === 'doctor') {
      const result = await pool.query(
        'SELECT doctor_id, full_name, email, specialty, color, status FROM doctors WHERE doctor_id = $1',
        [session.user_id]
      );
      user = result.rows[0];
      if (user) user.id = user.doctor_id;
    } else if (session.user_type === 'worker') {
      const result = await pool.query(
        'SELECT id, username FROM workers WHERE id = $1',
        [session.user_id]
      );
      user = result.rows[0];
    }

    if (!user) {
      return res.status(401).json({
        success: false,
        error: 'User not found'
      });
    }

    res.json({
      success: true,
      data: {
        ...user,
        userType: session.user_type
      }
    });

  } catch (error) {
    console.error('Get current user error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get user information'
    });
  }
});

/**
 * Refresh Session
 * Extends the current session expiration
 * POST /api/auth/refresh
 */
router.post('/refresh', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      return res.status(401).json({
        success: false,
        error: 'No token provided'
      });
    }

    const token = authHeader.replace('Bearer ', '');

    // Update session expiration
    const newExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    const result = await pool.query(
      `UPDATE user_sessions
       SET expires_at = $1, last_activity = NOW()
       WHERE token = $2 AND expires_at > NOW()
       RETURNING user_id, user_type`,
      [newExpiresAt, token]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        success: false,
        error: 'Invalid or expired token'
      });
    }

    res.json({
      success: true,
      data: {
        expiresAt: newExpiresAt.toISOString()
      }
    });

  } catch (error) {
    console.error('Refresh session error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to refresh session'
    });
  }
});

module.exports = router;
