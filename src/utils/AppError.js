// An "operational" error is an expected failure (bad input, not found,
// unauthorized, etc.) as opposed to a bug. Routes throw this instead of
// calling res.status(...).json(...) directly, and the central error
// handler turns it into the right HTTP response.
class AppError extends Error {
    constructor(message, statusCode) {
        super(message);
        this.statusCode = statusCode;
        this.isOperational = true;
        Error.captureStackTrace(this, this.constructor);
    }
}

module.exports = AppError;