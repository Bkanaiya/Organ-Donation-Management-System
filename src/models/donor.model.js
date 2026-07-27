const mongoose = require('mongoose');
const { ORGAN_TYPES, BLOOD_GROUPS, GENDERS } = require('../constants/enums');


const donatedOrganSchema = new mongoose.Schema({
    Organ: {
        type: String,
        required: [true, 'organ is required'],
        enum: ORGAN_TYPES
    },
    Status: {
        type: String,
        enum: ['available', 'matched', 'donated', 'unavailable'],
        default: 'available'
    }
}, { _id: false });

const donorSchema = new mongoose.Schema({
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
    DonorType: {
        type: String,
        required: [true, 'donor type is required'],
        enum: ['living', 'deceased']
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
    OrgansDonated: {
        type: [donatedOrganSchema],
        required: [true, 'at least one organ is required'],
        validate: {
            validator: (arr) => Array.isArray(arr) && arr.length > 0,
            message: 'at least one organ must be listed'
        }
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
    ConsentGiven: {
        type: Boolean,
        required: [true, 'consent status is required'],
        default: false
    },
    ConsentDate: {
        type: Date
    },
    Status: {
        type: String,
        enum: ['pending', 'verified', 'available', 'matched', 'donated', 'rejected'],
        default: 'pending'
    }
}, { timestamps: true });

// Common lookup pattern for matching: find available donors by organ + blood group + location.
donorSchema.index({ 'OrgansDonated.Organ': 1, BloodGroup: 1, State: 1, District: 1 });

module.exports = mongoose.model('Donor', donorSchema);