const mongoose = require('mongoose');
const { ORGAN_TYPES, BLOOD_GROUPS, GENDERS } = require('../constants/enums');

const receiverSchema = new mongoose.Schema({
    Name: {
        type: String,
        required: [true, 'name is required'],
        trim: true
    },
    Age: {
        type: Number,
        required: [true, 'age is required'],
        min: [0, 'age cannot be negative'],
        max: [120, 'enter a valid age']
    },
    Gender: {
        type: String,
        required: [true, 'enter the gender'],
        enum: GENDERS
    },
    BloodGroup: {
        type: String,
        required: [true, 'blood group is required'],
        enum: BLOOD_GROUPS
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
    Organ_needed: {
        type: String,
        required: [true, 'organ is required'],
        enum: ORGAN_TYPES,
        trim: true
    },
    Urgency: {
        type: String,
        required: [true, 'urgency level is required'],
        enum: ['critical', 'urgent', 'stable'],
        default: 'stable'
    },
    Hospital: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Hospital'
    },
    IsVerified: {
        type: Boolean,
        default: false
    },
    VerifiedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Hospital'
    },
    WaitlistDate: {
        type: Date,
        default: Date.now
    },
    Status: {
        type: String,
        enum: ['pending', 'verified', 'waiting', 'matched', 'transplanted', 'rejected'],
        default: 'pending'
    }
}, { timestamps: true });

// Common lookup pattern for matching: find waiting receivers by organ + blood group + location,
// ordered by urgency.
receiverSchema.index({ Organ_needed: 1, BloodGroup: 1, State: 1, District: 1 });

module.exports = mongoose.model('Receiver', receiverSchema);