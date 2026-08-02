const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
    Name: {
        type: String,
        required: [true, 'name is required'],
        trim: true
    },
    Email: {
        type: String,
        required: [true, 'email is required'],
        unique: true,
        trim: true,
        lowercase: true
    },
    Password: {
        type: String,
        required: [true, 'password is required'],
        select: false // never return password hash in queries by default
    },
    Role: {
        type: String,
        required: [true, 'role is required'],
        enum: ['admin', 'hospital', 'donor', 'receiver'],
        default: 'donor'
    },
    // Only relevant when Role === 'hospital' — links this login to a Hospital record.
    Hospital: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Hospital'
    },
    // Only relevant when Role === 'donor' / 'receiver' — links this login to
    // their own Donor/Receiver record, so they can view (but not necessarily
    // edit) only their own data instead of anyone else's.
    LinkedDonor: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Donor'
    },
    LinkedReceiver: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Receiver'
    }
}, { timestamps: true });

module.exports = mongoose.model('User', userSchema);