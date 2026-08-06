const AuditLog = require('../models/auditLog.model');
const logger = require('./logger');

// Build the actor + request metadata from req. Returns null if req is missing
// (e.g. called from a script).
function actorFromReq(req) {
    if (!req || !req.user) return null;
    return {
        userId: req.user.id || req.user._id,
        hospitalId: req.user.Hospital,
        role: req.user.Role
    };
}

// Best-effort audit write. Failures are logged at warn but don't propagate —
// audit is a side-effect, not a precondition for the user-visible response.
async function logAudit({ event, actor, targetType, targetId, payload, hospitalId, req }) {
    try {
        const a = actor || actorFromReq(req);
        await AuditLog.create({
            Event: event,
            Actor: a,
            TargetType: targetType,
            TargetId: targetId,
            RequestId: (req && req.id) || undefined,
            HospitalId: hospitalId || (a && a.hospitalId),
            IpAddress: req && (req.ip || (req.headers && req.headers['x-forwarded-for'])),
            UserAgent: req && req.headers && req.headers['user-agent'],
            Payload: payload
        });
    } catch (err) {
        logger.warn({ err, event, targetType, targetId }, 'audit log write failed');
    }
}

module.exports = { logAudit, actorFromReq };