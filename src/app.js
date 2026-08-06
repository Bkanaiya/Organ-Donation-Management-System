const express = require('express');
const pinoHttp = require('pino-http');
const logger = require('./utils/logger');
const AppError = require('./utils/AppError');
const errorHandler = require('./middleware/errorHandler');

const authRoutes = require('./routes/auth.routes');
const locationRoutes = require('./routes/location.routes');
const hospitalRoutes = require('./routes/hospital.routes');
const donorRoutes = require('./routes/donor.routes');
const receiverRoutes = require('./routes/receiver.routes');
const matchRoutes = require('./routes/match.routes');

const app = express();

// Request logging + id first, so every subsequent middleware can log lines
// correlated by req.id. genReqId makes the id visible both in the response
// header (X-Request-Id) and on req.log / req.id for downstream code.
app.use(pinoHttp({
    logger,
    genReqId: (req) => req.headers['x-request-id'] || require('crypto').randomUUID(),
    customLogLevel: (req, res, err) => {
        if (err || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
    },
    customSuccessMessage: (req, res) => `${req.method} ${req.url} ${res.statusCode}`,
    customErrorMessage: (req, res, err) => `${req.method} ${req.url} ${res.statusCode} - ${err.message}`
}));

// Cap request body size — without this, a malicious client can exhaust
// memory with a multi-MB JSON payload before the route even fires.
app.use(express.json({ limit: '100kb' }));

app.get('/', (req, res) => {
    res.send('Organ Donation API is running');
});

app.use('/api/auth', authRoutes);
app.use('/api/districts', locationRoutes);
app.use('/api/hospital', hospitalRoutes);
app.use('/api/donor', donorRoutes);
app.use('/api/receiver', receiverRoutes);
app.use('/api/match', matchRoutes);

// --- 404 for unmatched routes ---------------------------------------------
// Must come after every real route and before the error handler.
app.use((req, res, next) => {
    next(new AppError(`route not found: ${req.method} ${req.originalUrl}`, 404));
});

// --- Central error handler --------------------------------------------
// Must be registered last — Express identifies it as an error handler
// specifically because it takes 4 arguments (err, req, res, next).
app.use(errorHandler);

module.exports = app;
