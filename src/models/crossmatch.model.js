const mongoose = require('mongoose');
const { ORGAN_TYPES } = require('../constants/enums');

// A crossmatch is donor-recipient-pair-specific: the recipient's serum is
// tested against the donor's cells, so a negative result for Receiver A says
// NOTHING about Receiver B. Storing it on the donor organ (as the old model
// did) silently reused one pair's result for every receiver — a negative for
// A could incorrectly clear the same organ for B. This model captures the
// result for the exact (Donor, Receiver, Organ) triple it belongs to.
const crossmatchSchema = new mongoose.Schema({
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
    Result: {
        type: String,
        enum: ['negative', 'positive', 'pending', 'not_done'],
        default: 'not_done'
    },
    Method: {
        type: String,
        enum: ['flow_cytometry', 'complement_dependent_cytotoxicity', 'virtual'],
        default: 'flow_cytometry'
    },
    TestedAt: {
        type: Date,
        default: Date.now
    },
    TestedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    },
    Notes: String
}, { timestamps: true });

// Crossmatch results are an APPEND-ONLY history for a pair, NOT a single
// mutable row. A pair's labs can run multiple tests (an initial negative, a
// later positive after sensitization, a re-test before transplant); each is a
// separate row ordered by TestedAt. Consumers read the LATEST row, so a
// re-recorded result never rewrites history and every result stays auditable.
// There is deliberately no unique index on (Donor, Receiver, Organ).
crossmatchSchema.index({ Receiver: 1, Organ: 1, Donor: 1, TestedAt: -1 });

module.exports = mongoose.model('Crossmatch', crossmatchSchema);
