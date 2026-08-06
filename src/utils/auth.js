const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// Resolved lazily so dotenv.config() (called in server.js / tests/setup.js
// at startup) has a chance to populate process.env.JWT_SECRET before we
// first sign or verify a token. Capturing it at module-load would race
// against dotenv and we'd see "secretOrPrivateKey must have a value".
function getSecret() {
    const secret = process.env.JWT_SECRET;
    if (process.env.NODE_ENV === 'production') {
        if (!secret || secret.length < 32) {
            throw new Error('JWT_SECRET must be set and at least 32 characters in production');
        }
    }
    return secret;
}

// Issuer / audience are checked on every verifyToken so tokens issued by
// another service (or for a different client) can't be replayed against this API.
const ISSUER = 'organ-donation-api';
const AUDIENCE = 'organ-donation-client';

// Shorter access tokens in production (15m), longer for tests / dev so the
// existing supertest helpers don't have to handle refresh flows.
const ACCESS_TTL = process.env.NODE_ENV === 'production' ? '15m' : '7d';

// A pre-computed bcrypt-12 hash of a random unguessable string. Used by
// login() to keep the response time constant when the email is unknown, so
// an attacker can't enumerate registered emails via timing.
const DUMMY_HASH = '$2a$12$5TEgXECUG6J3nFbwcte1t.SLu5NSWT7v.vprNteqcemzxiLF2Eqim';

async function hashPassword(plainPassword) {
    const salt = await bcrypt.genSalt(10);
    return bcrypt.hash(plainPassword, salt);
}

async function comparePassword(plainPassword, hashedPassword) {
    return bcrypt.compare(plainPassword, hashedPassword);
}

// Signs a JWT containing { id, Role, Hospital, LinkedDonor, LinkedReceiver, jti }.
// `Hospital` is included for client-side visibility only — it is intentionally
// not signed as authoritative. The scopeToHospital middleware re-reads
// `User.Hospital` from the DB on every request that needs it, so that
// a user who has been reassigned to a different hospital mid-session
// cannot continue to act against the old hospital until token expiry.
function generateToken(user) {
    return jwt.sign(
        {
            id: user._id,
            Role: user.Role,
            Hospital: user.Hospital,
            LinkedDonor: user.LinkedDonor,
            LinkedReceiver: user.LinkedReceiver,
            jti: crypto.randomUUID()
        },
        getSecret(),
        {
            expiresIn: ACCESS_TTL,
            issuer: ISSUER,
            audience: AUDIENCE
        }
    );
}

function verifyToken(token) {
    return jwt.verify(token, getSecret(), { issuer: ISSUER, audience: AUDIENCE });
}

module.exports = { hashPassword, comparePassword, generateToken, verifyToken, DUMMY_HASH };
