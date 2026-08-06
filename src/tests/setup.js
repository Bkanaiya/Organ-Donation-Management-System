// Tests need a real MongoDB to talk to, but we do NOT want them touching your
// actual Atlas database — that would pollute real data and make tests slow
// and order-dependent. mongodb-memory-server spins up a temporary, in-memory
// MongoDB that lives only for the duration of the test run, then disappears.
//
// The first time this runs on your machine, it downloads a small MongoDB
// binary (one-time, then cached) — so you'll need internet access for that
// first run.
//
// We spin up a single-node replica set so that MongoDB transactions work
// (transactions require a replica set or a sharded cluster; standalone
// servers reject them). src/services/match.service.js uses session.withTransaction
// for atomic createMatch.

require('dotenv').config();
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let replSet;

// Call this once before all tests in a file (in a `beforeAll` block).
async function connectTestDB() {
    replSet = await MongoMemoryReplSet.create({
        replSet: { count: 1, storageEngine: 'wiredTiger' }
    });
    const uri = replSet.getUri();
    await mongoose.connect(uri);

    // Sanity-check the replica set is actually running. Without this the
    // first createMatch call would fail with "Transaction numbers are only
    // allowed on a replica set member or mongos" deep inside the driver.
    const status = await mongoose.connection.db.admin().command({ replSetGetStatus: 1 });
    if (!status || !status.set) {
        throw new Error('mongodb-memory-server is not running as a replica set; transactions will fail');
    }
}

// Call this once after all tests in a file (in an `afterAll` block).
async function closeTestDB() {
    await mongoose.connection.dropDatabase();
    await mongoose.connection.close();
    await replSet.stop();
}

// Call this between tests (in an `afterEach` block) so one test's data
// doesn't leak into and affect the next test.
async function clearTestDB() {
    const collections = mongoose.connection.collections;
    for (const key in collections) {
        await collections[key].deleteMany({});
    }
}

module.exports = { connectTestDB, closeTestDB, clearTestDB };
