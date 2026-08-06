const mongoose = require('mongoose');
const { ORGAN_TYPES } = require('../constants/enums');

// Phases of the per-organ allocation workflow. `reserved` is the state a match
// enters when createMatch succeeds; downstream endpoints (approve / cancel /
// complete) advance the phase. The legacy `Status` enum is kept for backward
// compatibility and is updated alongside `AllocationPhase` for clients that
// haven't migrated.
const matchSchema = new mongoose.Schema({
    Donor: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Donor',
        required: [true, 'donor is required']
    },
    Receiver: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Receiver',
        required: [true, 'receiver is required']
    },
    Organ: {
        type: String,
        required: [true, 'organ is required'],
        enum: ORGAN_TYPES
    },
    Hospital: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Hospital',
        required: [true, 'hospital is required']
    },
    Status: {
        type: String,
        enum: ['pending', 'approved', 'in_progress', 'completed', 'failed', 'cancelled'],
        default: 'pending'
    },
    // Source of truth for the per-organ workflow. Newer code reads this;
    // the legacy `Status` is updated alongside it for older clients.
    AllocationPhase: {
        type: String,
        enum: ['suggested', 'reserved', 'crossmatch_confirmed', 'accepted', 'in_progress', 'completed', 'failed', 'cancelled'],
        default: 'reserved'
    },
    MatchedDate: {
        type: Date,
        default: Date.now
    },
    CompletedDate: {
        type: Date
    },
    Notes: {
        type: String,
        trim: true
    },
    // Explainable scoring fields. `Score` is the final total; `ScoreBreakdown`
    // carries every factor the scorer used, so the decision can be audited.
    Score: Number,
    ScoreBreakdown: {
        location: Number,
        urgency: Number,
        waitingTime: Number,
        ageProximity: Number,
        sizeMatch: Number,
        hlaMatch: Number,
        coldIschemiaRemaining: Number,
        policyVersion: String,
        weights: mongoose.Schema.Types.Mixed,
        factors: mongoose.Schema.Types.Mixed
    },
    PolicyVersion: String,
    OrganPolicySnapshot: mongoose.Schema.Types.Mixed,
    ColdIschemiaStartedAt: Date,
    MaxColdIschemia_min: Number,
    CreatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    ApprovedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    ApprovedAt: Date,
    CancelledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    CancelledAt: Date,
    CancellationReason: String
}, { timestamps: true });

matchSchema.index({ Donor: 1, Receiver: 1, Organ: 1 });
// Duplicate-receiver protection: a receiver can have at most one open match.
matchSchema.index({ Receiver: 1, AllocationPhase: 1 });
// Dashboard / hospital-scope queries.
matchSchema.index({ Hospital: 1, AllocationPhase: 1, MatchedDate: -1 });

module.exports = mongoose.model('Match', matchSchema);
