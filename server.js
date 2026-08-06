require('dotenv').config();
const http = require('http');
const app = require('./src/app');
const connectDB = require('./src/db/db');
const logger = require('./src/utils/logger');

// Crash fast on truly unexpected failures instead of running in a half-broken
// state. 'unhandledRejection' covers forgotten Promise.reject in async code
// (Node 15+ terminates the process by default, but we log first so the cause
// is captured before exit). 'uncaughtException' is for synchronous throw
// outside any handler — process state may be corrupted, so we exit.
process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'unhandled promise rejection');
    process.exit(1);
});

process.on('uncaughtException', (err) => {
    logger.error({ err }, 'uncaught exception');
    process.exit(1);
});

async function start() {
    await connectDB();

    // Use http.createServer(app) instead of app.listen() so we can tune the
    // server's timeouts. Defaults allow a slow client to hold a connection
    // open for ~2 minutes per socket — a slow-loris attacker can pin every
    // worker slot. The values below are deliberately conservative for a
    // JSON API (no long-polling, no large uploads).
    const server = http.createServer(app);
    server.timeout = 30_000;            // hard ceiling on a single request
    server.keepAliveTimeout = 5_000;    // kill idle keepalive sockets
    server.headersTimeout = 6_000;     // must be > keepAliveTimeout

    // Surface server-level errors (port already in use, socket exhaustion, …)
    // so they don't silently kill the process.
    server.on('error', (err) => {
        logger.error({ err }, 'http server error');
        process.exit(1);
    });

    const port = Number(process.env.PORT) || 3000;
    server.listen(port, () => logger.info({ port }, 'API listening'));
}

start().catch((error) => {
    logger.error({ err: error }, 'startup failed');
    process.exit(1);
});
