const mongoose = require('mongoose');
const { ORGAN_TYPES } = require('../constants/enums');


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
    }
}, { timestamps: true });

matchSchema.index({ Donor: 1, Receiver: 1, Organ: 1 });

module.exports = mongoose.model('Match', matchSchema);