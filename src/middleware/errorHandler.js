const AppError = require('../utils/AppError');
const logger = require('../utils/logger');

// Mongoose validation error (schema rule failed, e.g. missing required field,
// bad enum value, min/max violation). Collect every field's message, not just
// the first, so the client can fix everything in one round trip.
function handleValidationError(error) {
    const messages = Object.values(error.errors).map((e) => e.message);
    return new AppError(messages.join('; '), 400);
}

// Mongoose couldn't cast a value to the expected type — almost always means
// an :id param or an ObjectId field in the body isn't a valid ObjectId.
function handleCastError(error) {
    return new AppError(`invalid value for ${error.path}: ${error.value}`, 400);
}

// MongoDB duplicate key error (E11000) — happens on any field with `unique: true`
// (e.g. User.Email, Hospital.RegistrationNumber).
function handleDuplicateKeyError(error) {
    const field = Object.keys(error.keyValue || {})[0] || 'field';
    const value = error.keyValue ? error.keyValue[field] : '';
    return new AppError(`${field} '${value}' is already in use`, 409);
}

function handleJWTError() {
    return new AppError('invalid token, please log in again', 401);
}

function handleJWTExpiredError() {
    return new AppError('your session has expired, please log in again', 401);
}

// Express recognizes middleware with exactly 4 params as the error handler,
// and it must be registered last, after every route.
function errorHandler(error, req, res, next) {
    let err = error;

    if (err.name === 'ValidationError') err = handleValidationError(err);
    if (err.name === 'CastError') err = handleCastError(err);
    if (err.code === 11000) err = handleDuplicateKeyError(err);
    if (err.name === 'JsonWebTokenError') err = handleJWTError();
    if (err.name === 'TokenExpiredError') err = handleJWTExpiredError();

    const statusCode = err.isOperational ? err.statusCode : 500;
    const message = err.isOperational ? err.message : 'something went wrong on our end';

    // Log through the structured logger. Use req.log if pino-http attached it
    // (so the line carries req.id); fall back to the module-level logger.
    // Operational errors are routine 4xx — log them at warn. Anything else is
    // a programmer-error or runtime fault — log at error with full stack.
    const log = (req && req.log) || logger;
    if (err.isOperational) {
        log.warn({ err: { message: err.message, statusCode } }, 'request failed');
    } else {
        log.error({ err }, 'unexpected error');
    }

    res.status(statusCode).json({ message });
}

module.exports = errorHandler;