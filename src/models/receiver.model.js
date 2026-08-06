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
    },
    // HLA + sensitization data — drives kidney/marrow allocation. Optional
    // until the receiver is screened by the transplant coordinator.
    HLA_Typing: {
        A: { type: [String], default: undefined },
        B: { type: [String], default: undefined },
        DR: { type: [String], default: undefined }
    },
    cPRA: {
        type: Number,
        min: [0, 'cPRA cannot be negative'],
        max: [100, 'cPRA cannot exceed 100']
    },
    SensitizationEvents: Number,
    BloodAntibodyScreen: {
        latestPRA: Number,
        testedAt: Date
    },
    AcceptsExtendedCriteria: { type: Boolean, default: false },
    AcceptsPediatricOrgan: { type: Boolean, default: false },
    MinOrganWeight_grams: Number,
    MaxOrganWeight_grams: Number,
    DialysisDuration_months: Number
}, { timestamps: true });

// Common lookup pattern for matching: find waiting receivers by organ + blood group + location,
// ordered by urgency.
receiverSchema.index({ Organ_needed: 1, BloodGroup: 1, State: 1, District: 1 });

// Eligibility query filter — only used by the matcher to narrow the waitlist
// before per-organ eligibility is applied.
receiverSchema.index({ Organ_needed: 1, Status: 1, IsVerified: 1 });

module.exports = mongoose.model('Receiver', receiverSchema);