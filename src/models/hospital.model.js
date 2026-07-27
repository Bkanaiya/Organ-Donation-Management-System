const mongoose = require('mongoose');

const hospitalSchema = new mongoose.Schema({
    Name: {
        type: String,
        required: [true, 'hospital name is required'],
        trim: true
    },
    RegistrationNumber: {
        type: String,
        required: [true, 'hospital registration number is required'],
        unique: true,
        trim: true
    },
    State: {
        type: String,
        required: [true, 'state is required'],
        trim: true
    },
    District: {
        type: String,
        required: [true, 'district is required'],
        trim: true
    },
    Address: {
        type: String,
        trim: true
    },
    ContactNumber: {
        type: String,
        required: [true, 'contact number is required'],
        trim: true
    },
    Email: {
        type: String,
        trim: true,
        lowercase: true
    },
    IsVerified: {
        type: Boolean,
        default: false
    }
}, { timestamps: true });

module.exports = mongoose.model('Hospital', hospitalSchema);