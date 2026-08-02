// Wrap any async route handler with this instead of writing try/catch in
// every route. If the handler throws or its promise rejects, the error is
// forwarded to next(), which hands it to the central error-handling
// middleware in middleware/errorHandler.js.
//
// Usage: app.get('/route', catchAsync(async (req, res) => { ... }))
function catchAsync(fn) {
    return (req, res, next) => {
        Promise.resolve(fn(req, res, next)).catch(next);
    };
}

module.exports = catchAsync;