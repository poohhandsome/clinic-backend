/* ===============================================================
   ADMIN MANAGEMENT ROUTES
   CRUD operations for admin accounts
   =============================================================== */

const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const pool = require('../db');
const { authenticateAdmin } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

/**
 * Get All Admins
 * GET /api/admins
 */
router.get('/', authenticateAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
        admin_id,
        full_name,
        email,
        phone,
        profile_picture_url,
        status,
        permissions,
        last_login,
        created_at,
        updated_at
       FROM admins
       ORDER BY created_at DESC`
    );

    res.json({
      success: true,
      data: result.rows
    });

  } catch (error) {
    console.error('Get admins error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch admins'
    });
  }
});

/**
 * Get Single Admin
 * GET /api/admins/:id
 */
router.get('/:id', authenticateAdmin, async (req, res) => {
  try {
    const adminId = parseInt(req.params.id);

    const result = await pool.query(
      `SELECT
        admin_id,
        full_name,
        email,
        phone,
        profile_picture_url,
        status,
        permissions,
        last_login,
        created_at,
        updated_at
       FROM admins
       WHERE admin_id = $1`,
      [adminId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Admin not found'
      });
    }

    res.json({
      success: true,
      data: result.rows[0]
    });

  } catch (error) {
    console.error('Get admin error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch admin'
    });
  }
});

/**
 * Create New Admin
 * POST /api/admins
 */
router.post('/', authenticateAdmin, async (req, res) => {
  try {
    const { fullName, email, password, phone, permissions } = req.body;

    // Validation
    if (!fullName || !email || !password) {
      return res.status(400).json({
        success: false,
        error: 'Full name, email, and password are required'
      });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid email format'
      });
    }

    // Check if email already exists
    const existing = await pool.query(
      'SELECT admin_id FROM admins WHERE email = $1',
      [email]
    );

    if (existing.rows.length > 0) {
      return res.status(400).json({
        success: false,
        error: 'Email already exists'
      });
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);

    // Default permissions if not provided
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

    // Create admin
    const result = await pool.query(
      `INSERT INTO admins (full_name, email, password_hash, phone, permissions, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING admin_id, full_name, email, status, created_at`,
      [
        fullName,
        email,
        passwordHash,
        phone || null,
        JSON.stringify(permissions || defaultPermissions),
        req.user.userId
      ]
    );

    // Log audit
    await logAudit(
      req.user.userId,
      'admin',
      'create_admin',
      'admins',
      result.rows[0].admin_id,
      null,
      { email, fullName },
      req
    );

    res.status(201).json({
      success: true,
      data: result.rows[0],
      message: 'Admin created successfully'
    });

  } catch (error) {
    console.error('Create admin error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create admin'
    });
  }
});

/**
 * Update Admin
 * PUT /api/admins/:id
 */
router.put('/:id', authenticateAdmin, async (req, res) => {
  try {
    const adminId = parseInt(req.params.id);
    const { fullName, email, phone, status, permissions, password } = req.body;

    // Get old data for audit
    const oldData = await pool.query(
      'SELECT * FROM admins WHERE admin_id = $1',
      [adminId]
    );

    if (oldData.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Admin not found'
      });
    }

    // Build update query dynamically
    const updates = [];
    const values = [];
    let paramCount = 1;

    if (fullName !== undefined) {
      updates.push(`full_name = $${paramCount}`);
      values.push(fullName);
      paramCount++;
    }

    if (email !== undefined) {
      // Check if email is taken by another admin
      const emailCheck = await pool.query(
        'SELECT admin_id FROM admins WHERE email = $1 AND admin_id != $2',
        [email, adminId]
      );

      if (emailCheck.rows.length > 0) {
        return res.status(400).json({
          success: false,
          error: 'Email already exists'
        });
      }

      updates.push(`email = $${paramCount}`);
      values.push(email);
      paramCount++;
    }

    if (phone !== undefined) {
      updates.push(`phone = $${paramCount}`);
      values.push(phone);
      paramCount++;
    }

    if (status !== undefined) {
      updates.push(`status = $${paramCount}`);
      values.push(status);
      paramCount++;
    }

    if (permissions !== undefined) {
      updates.push(`permissions = $${paramCount}`);
      values.push(JSON.stringify(permissions));
      paramCount++;
    }

    if (password !== undefined && password.length > 0) {
      const passwordHash = await bcrypt.hash(password, 10);
      updates.push(`password_hash = $${paramCount}`);
      values.push(passwordHash);
      paramCount++;
    }

    if (updates.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No fields to update'
      });
    }

    updates.push(`updated_at = NOW()`);
    values.push(adminId);

    const query = `
      UPDATE admins
      SET ${updates.join(', ')}
      WHERE admin_id = $${paramCount}
      RETURNING admin_id, full_name, email, phone, status, permissions, updated_at
    `;

    const result = await pool.query(query, values);

    // Log audit
    await logAudit(
      req.user.userId,
      'admin',
      'update_admin',
      'admins',
      adminId,
      oldData.rows[0],
      result.rows[0],
      req
    );

    res.json({
      success: true,
      data: result.rows[0],
      message: 'Admin updated successfully'
    });

  } catch (error) {
    console.error('Update admin error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update admin'
    });
  }
});

/**
 * Delete/Deactivate Admin
 * DELETE /api/admins/:id
 */
router.delete('/:id', authenticateAdmin, async (req, res) => {
  try {
    const adminId = parseInt(req.params.id);

    // Don't allow deleting yourself
    if (adminId === req.user.userId) {
      return res.status(400).json({
        success: false,
        error: 'Cannot delete your own account'
      });
    }

    // Get admin before deletion for audit
    const adminData = await pool.query(
      'SELECT * FROM admins WHERE admin_id = $1',
      [adminId]
    );

    if (adminData.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Admin not found'
      });
    }

    // Soft delete - set status to inactive
    await pool.query(
      'UPDATE admins SET status = $1, updated_at = NOW() WHERE admin_id = $2',
      ['inactive', adminId]
    );

    // Invalidate all sessions for this admin
    await pool.query(
      'DELETE FROM user_sessions WHERE user_id = $1 AND user_type = $2',
      [adminId, 'admin']
    );

    // Log audit
    await logAudit(
      req.user.userId,
      'admin',
      'delete_admin',
      'admins',
      adminId,
      adminData.rows[0],
      { status: 'inactive' },
      req
    );

    res.json({
      success: true,
      message: 'Admin deactivated successfully'
    });

  } catch (error) {
    console.error('Delete admin error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete admin'
    });
  }
});

/**
 * Reactivate Admin
 * POST /api/admins/:id/reactivate
 */
router.post('/:id/reactivate', authenticateAdmin, async (req, res) => {
  try {
    const adminId = parseInt(req.params.id);

    const result = await pool.query(
      `UPDATE admins
       SET status = 'active', updated_at = NOW()
       WHERE admin_id = $1
       RETURNING admin_id, full_name, email, status`,
      [adminId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Admin not found'
      });
    }

    // Log audit
    await logAudit(
      req.user.userId,
      'admin',
      'reactivate_admin',
      'admins',
      adminId,
      null,
      { status: 'active' },
      req
    );

    res.json({
      success: true,
      data: result.rows[0],
      message: 'Admin reactivated successfully'
    });

  } catch (error) {
    console.error('Reactivate admin error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to reactivate admin'
    });
  }
});

module.exports = router;
