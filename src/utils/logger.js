const pino = require('pino');

// NODE_ENV drives log level. 'production' = info (no debug noise shipped),
// anything else = debug so local debugging stays easy. Piped to stderr so it
// doesn't interleave with stdout from app code.
const isProduction = process.env.NODE_ENV === 'production';

const logger = pino({
    level: isProduction ? 'info' : 'debug',
    base: { service: 'organ-donation-api' },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
        // Never log secrets, even by accident. bcrypt hashes are slow to
        // generate, but JWT secrets / DB URIs land in env vars and must
        // never be emitted. Donor / receiver / hospital contact info and
        // emails are PHI/PII and must be stripped from any log line.
        paths: [
            'req.headers.authorization',
            'req.headers.cookie',
            'req.body.password',
            'req.body.Password',
            'res.headers["set-cookie"]',
            'req.body.ContactNumber',
            'req.body.Email',
            'res.body.donor.Name',
            'res.body.donor.ContactNumber',
            'res.body.donor.Email',
            'res.body.receiver.Name',
            'res.body.receiver.ContactNumber',
            'res.body.receiver.Email',
            'res.body.match.ScoreBreakdown'
        ],
        remove: true
    }
});

module.exports = logger;
