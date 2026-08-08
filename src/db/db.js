const mongoose = require('mongoose')

// Transactions require the server to be a replica set or sharded cluster —
// the matcher uses session.withTransaction in src/services/match.service.js
// for the createMatch flow. The dev/test harness spins up a replicaSet via
// mongodb-memory-server; production MONGO_URI MUST point at a replica set
// or a sharded cluster, otherwise matches will fail at the transaction call.
//
// connectDB therefore verifies replica-set membership at startup and fails
// loud when it's missing — a standalone mongod connects fine, so without this
// check the server would boot and only crash later on the first createMatch.
async function connectDB() {
    const uri = process.env.MONGO_URI

    if (!uri) {
        throw new Error('MONGO_URI is not set — cannot connect to MongoDB')
    }

    await mongoose.connect(uri)

    try {
        const status = await mongoose.connection.db.admin().command({ replSetGetStatus: 1 })
        if (!status || !status.set) {
            throw new Error('replSetGetStatus returned no replica-set name')
        }
        console.log(`Connected to MongoDB replica set "${status.set}"`)
    } catch (err) {
        const message = err && err.message ? err.message : String(err)
        if (/not authorized|unauthorized|requires authentication/i.test(message)) {
            // The app user often lacks replSetGetStatus privileges (e.g. Atlas
            // non-admin users). Warn instead of blocking — but the deployment
            // still MUST be a replica set for transactions to work.
            console.warn('Could not verify replica-set membership (insufficient DB privileges). createMatch uses multi-document transactions, which REQUIRE a replica set or sharded cluster — verify MONGO_URI points at one.')
        } else if (/replica|replSet|repl set|standalone|no replset config/i.test(message)) {
            throw new Error('MONGO_URI points at a standalone mongod, but createMatch uses multi-document transactions. Point MONGO_URI at a replica set or sharded cluster (e.g. mongod --replSet rs0, or an Atlas M10+ cluster), then retry.')
        } else {
            throw new Error(`MongoDB connection failed: ${message}`)
        }
    }
}

module.exports = connectDB
