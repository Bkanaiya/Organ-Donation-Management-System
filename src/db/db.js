const mongoose =require('mongoose')

// Transactions require the server to be a replica set or sharded cluster —
// the matcher uses session.withTransaction in src/services/match.service.js
// for the createMatch flow. The dev/test harness spins up a replicaSet via
// mongodb-memory-server; production MONGO_URI MUST point at a replica set
// or a sharded cluster, otherwise matches will fail at the transaction call.
async function connectDB(){
    const uri = process.env.MONGO_URI

    await mongoose.connect(uri)
    console.log("Connected with DB")
}

module.exports = connectDB