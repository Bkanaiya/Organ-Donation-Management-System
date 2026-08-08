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
        pediatricPriority: Number,
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
    // The _id of the SPECIFIC donor.OrgansDonated subdoc this match reserved.
    // A donor may list the same organ twice (e.g. two kidneys); lifecycle
    // writes (releaseMatchSideEffects / completeMatch) filter on this id so
    // the positional $ operator releases the exact reserved entry instead of
    // the first row that happens to share the organ name.
    OrganEntryId: {
        type: mongoose.Schema.Types.ObjectId
    },
    // True when the organ was ALREADY procured (IschemiaStartedAt set) before
    // createMatch reserved it; false when createMatch itself stamped the
    // ischemia clock on reservation. The distinction decides whether a
    // canceled pre-procurement match may clear IschemiaStartedAt — a clock
    // stamped by the reservation, not a real procurement, must not age the
    // organ (see releaseMatchSideEffects).
    ProcuredBeforeMatch: {
        type: Boolean,
        default: false
    },
    // The receiver's status immediately before this match flipped them to
    // 'matched'. Cancel/release restores it exactly: kidney-style policies
    // match from 'waiting', but tissue policies (cornea/skin/bone/valve)
    // accept 'verified' receivers — a blanket 'waiting' restore would
    // silently demote a verified tissue recipient.
    ReceiverStatusBeforeMatch: {
        type: String,
        enum: ['pending', 'verified', 'waiting'],
        default: undefined
    },
    CreatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    ApprovedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    ApprovedAt: Date,
    CancelledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    CancelledAt: Date,
    CancellationReason: String,
    // A match that fails at surgery (organ unusable, recipient decompensates)
    // exits through /fail, NOT /cancel — cancel implies a non-clinical,
    // planner-side withdrawal and writes CancellationReason / MATCH_CANCELLED.
    FailedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    FailedAt: Date,
    FailureReason: String
}, { timestamps: true });

matchSchema.index({ Donor: 1, Receiver: 1, Organ: 1 });
// Duplicate-receiver protection, made ATOMIC. The in-memory pre-check in
// createMatch is the friendly fast path, but it races: two concurrent
// createMatch calls for the same receiver can both pass it. This unique
// partial index is the real enforcement — the second insert fails with
// E11000 and its transaction rolls back. Only open phases are indexed;
// completed/cancelled/failed matches fall outside the partial filter so a
// receiver can match again once their prior match closed.
matchSchema.index(
    { Receiver: 1 },
    { unique: true, partialFilterExpression: { AllocationPhase: { $in: ['reserved', 'crossmatch_confirmed', 'accepted', 'in_progress'] } } }
);
// Dashboard / hospital-scope queries.
matchSchema.index({ Hospital: 1, AllocationPhase: 1, MatchedDate: -1 });

module.exports = mongoose.model('Match', matchSchema);
