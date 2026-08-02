// Tests need a real MongoDB to talk to, but we do NOT want them touching your
// actual Atlas database — that would pollute real data and make tests slow
// and order-dependent. mongodb-memory-server spins up a temporary, in-memory
// MongoDB that lives only for the duration of the test run, then disappears.
//
// The first time this runs on your machine, it downloads a small MongoDB
// binary (one-time, then cached) — so you'll need internet access for that
// first run.

require('dotenv').config();
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongoServer;

// Call this once before all tests in a file (in a `beforeAll` block).
async function connectTestDB() {
    mongoServer = await MongoMemoryServer.create();
    const uri = mongoServer.getUri();
    await mongoose.connect(uri);
}

// Call this once after all tests in a file (in an `afterAll` block).
async function closeTestDB() {
    await mongoose.connection.dropDatabase();
    await mongoose.connection.close();
    await mongoServer.stop();
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