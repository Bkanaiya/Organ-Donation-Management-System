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
        enum: ['available', 'verified', 'matched', 'donated', 'unavailable'],
        default: 'available'
    },
    // HLA typing is organ-specific (kidney/marrow). Optional — populated when
    // the donor is screened by the transplant coordinator.
    HLA_Typing: {
        A: { type: [String], default: undefined },
        B: { type: [String], default: undefined },
        DR: { type: [String], default: undefined }
    },
// Crossmatch is donor-recipient-PAIR-specific and is NOT stored here — a
// result for one receiver must never clear the organ for another. Pair
// results live in the Crossmatch model (see models/crossmatch.model.js).
// cPRA is likewise a receiver-side sensitization measure and has no
// meaningful donor equivalent, so it is not recorded on the donor either.
// The subdoc keeps its auto-generated _id (NOT _id:false) so allocation
// lifecycle updates (reserve/release/complete) can target ONE specific
// entry by id — a donor may list the same organ twice (e.g. two kidneys),
// and the positional $ operator keyed on the organ name alone would hit the
// wrong row. The Match row captures the reserved entry's _id in
// OrganEntryId and every lifecycle write filters on it.
    OrganWeight_grams: Number,
    OrganQuality: {
        type: String,
        enum: ['ideal', 'extended_criteria', 'marginal'],
        default: 'ideal'
    },
    ColdIschemiaLimit_min: Number,
    IschemiaStartedAt: Date,
    IsPediatric: { type: Boolean, default: false },
    // Serology panel — each marker must be present and explicitly false
    // before the organ is allowed to match. Absent fields count as
    // "not screened" rather than "negative" — fail closed.
    InfectionScreening: {
        HIV: { type: Boolean, default: undefined },
        HepB: { type: Boolean, default: undefined },
        HepC: { type: Boolean, default: undefined },
        CMV: { type: Boolean, default: undefined },
        EBV: { type: Boolean, default: undefined },
        Syphilis: { type: Boolean, default: undefined }
    }
});

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
    },
    MedicalHistory: {
        Hypertension: Boolean,
        Diabetes: Boolean,
        Malignancy: Boolean,
        MalignancyFreeYears: Number
    }
}, { timestamps: true });

// Common lookup pattern for matching: find available donors by organ + blood group + location.
donorSchema.index({ 'OrgansDonated.Organ': 1, BloodGroup: 1, State: 1, District: 1 });

// Eligibility query filter: look up donors that have been verified + consented
// AND are still in an active allocation state. Partial-filter index keeps it
// small — the docs we filter out don't take up index space.
donorSchema.index(
    { IsVerified: 1, ConsentGiven: 1, Status: 1 },
    { partialFilterExpression: { Status: { $in: ['available', 'verified'] } } }
);

module.exports = mongoose.model('Donor', donorSchema);