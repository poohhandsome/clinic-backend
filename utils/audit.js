/* -------------------------------------------------- */
/* FILE: utils/audit.js (Audit Logging Utility)       */
/* -------------------------------------------------- */

const db = require('../db');

/**
 * Log an audit event to the audit_logs table
 *
 * @param {number|null} userId - The ID of the user performing the action
 * @param {string} userType - Type of user: 'doctor', 'worker', 'admin'
 * @param {string} action - Action performed (e.g., 'create_patient', 'update_treatment', 'delete_record')
 * @param {string} tableName - Name of the table affected
 * @param {number|string} recordId - ID of the record affected
 * @param {object|null} oldValues - Previous values (for updates/deletes)
 * @param {object|null} newValues - New values (for creates/updates)
 * @param {object} req - Express request object for IP and user agent
 */
async function logAudit(userId, userType, action, tableName, recordId, oldValues, newValues, req) {
  try {
    // Extract IP address (handle proxy scenarios)
    const ipAddress = req.ip || req.connection?.remoteAddress || req.socket?.remoteAddress || 'unknown';

    // Extract user agent
    const userAgent = req.headers['user-agent'] || 'unknown';

    await db.query(`
      INSERT INTO audit_logs
      (user_id, user_type, action, table_name, record_id, old_values, new_values, ip_address, user_agent)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `, [
      userId,
      userType,
      action,
      tableName,
      recordId ? String(recordId) : null,
      oldValues ? JSON.stringify(oldValues) : null,
      newValues ? JSON.stringify(newValues) : null,
      ipAddress,
      userAgent
    ]);

    console.log(`[AUDIT] ${userType} ${userId} performed ${action} on ${tableName} record ${recordId}`);
  } catch (error) {
    // Don't throw - audit logging shouldn't break main functionality
    console.error('Audit log error:', error.message);
    // Log to console for monitoring but don't fail the request
  }
}

/**
 * Wrapper for patient-related audit logs
 */
async function logPatientAudit(userId, userType, action, patientId, oldData, newData, req) {
  return logAudit(userId, userType, action, 'patients', patientId, oldData, newData, req);
}

/**
 * Wrapper for visit-related audit logs
 */
async function logVisitAudit(userId, userType, action, visitId, oldData, newData, req) {
  return logAudit(userId, userType, action, 'visits', visitId, oldData, newData, req);
}

/**
 * Wrapper for billing-related audit logs
 */
async function logBillingAudit(userId, userType, action, billingId, oldData, newData, req) {
  return logAudit(userId, userType, action, 'billing', billingId, oldData, newData, req);
}

/**
 * Wrapper for treatment-related audit logs
 */
async function logTreatmentAudit(userId, userType, action, treatmentId, oldData, newData, req) {
  return logAudit(userId, userType, action, 'treatments', treatmentId, oldData, newData, req);
}

module.exports = {
  logAudit,
  logPatientAudit,
  logVisitAudit,
  logBillingAudit,
  logTreatmentAudit
};
