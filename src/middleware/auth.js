const { verifyToken } = require('../utils/auth');
const AppError = require('../utils/AppError');
const User = require('../models/user.model');

// Reads "Authorization: Bearer <token>", verifies it, and attaches the
// decoded payload ({ id, Role, LinkedDonor, LinkedReceiver }) to req.user
// for downstream routes.
function authenticate(req, res, next) {
    const header = req.headers.authorization;

    if (!header || !header.startsWith('Bearer ')) {
        return next(new AppError('no token provided', 401));
    }

    const token = header.split(' ')[1];

    try {
        req.user = verifyToken(token);
        next();
    } catch (error) {
        // verifyToken throws JsonWebTokenError/TokenExpiredError — let the
        // central error handler translate those into the right message.
        next(error);
    }
}

// Usage: authorize('admin', 'hospital') — call authenticate first so req.user exists.
function authorize(...allowedRoles) {
    return (req, res, next) => {
        if (!req.user) {
            return next(new AppError('authentication required', 401));
        }
        if (!allowedRoles.includes(req.user.Role)) {
            return next(new AppError('you do not have permission to perform this action', 403));
        }
        next();
    };
}

// Lets admin/hospital through unconditionally, OR lets a donor/receiver through
// only if the record they're requesting is the one linked to their own account.
// `linkedField` is which req.user property holds their own record's id
// (e.g. 'LinkedDonor'), and `paramName` is the route param to compare it against
// (e.g. 'id' for /api/donor/:id).
function authorizeSelfOrRoles(linkedField, paramName, ...privilegedRoles) {
    return (req, res, next) => {
        if (!req.user) {
            return next(new AppError('authentication required', 401));
        }
        if (privilegedRoles.includes(req.user.Role)) {
            return next();
        }
        const ownRecordId = req.user[linkedField];
        if (ownRecordId && ownRecordId === req.params[paramName]) {
            return next();
        }
        return next(new AppError('you do not have permission to view this record', 403));
    };
}

// Hospital-scope enforcement. Run AFTER `authorize('admin', 'hospital')` so
// admins short-circuit before the DB read and so unauthorized callers have
// already been rejected. We intentionally do NOT trust `req.user.Hospital`
// from the JWT — the User record is re-fetched so a reassigned user cannot
// keep operating against their old hospital until the token expires.
async function scopeToHospital(req, res, next) {
    if (!req.user) {
        return next(new AppError('authentication required', 401));
    }

    if (req.user.Role === 'admin') {
        return next();
    }

    const user = await User.findById(req.user.id).select('Role Hospital');
    if (!user) {
        return next(new AppError('authentication required', 401));
    }

    if (!user.Hospital) {
        return next(new AppError('hospital scope not configured for this account', 403));
    }

    // Overwrite whatever the token carried with the live, authoritative value.
    req.user.Hospital = String(user.Hospital);
    next();
}

module.exports = { authenticate, authorize, authorizeSelfOrRoles, scopeToHospital };