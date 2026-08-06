const mongoose = require('mongoose');

// Generic audit log — one document per clinical decision. Lives outside any
// transactional boundary by default; createMatch writes its row inside the
// Match transaction so the audit is consistent with the match itself.
//
// `Event` is the action; `TargetType`/`TargetId` identify what was acted on;
// `Payload` is event-specific (see match.service.js for the per-event shapes);
// `Actor` records who took the action. `RequestId` is the pino-http request id
// so log lines and audit rows can be correlated end-to-end.
const auditLogSchema = new mongoose.Schema({
    Event: {
        type: String,
        required: true,
        enum: [
            'MATCH_SUGGESTED',
            'MATCH_CREATED',
            'MATCH_OVERRIDDEN',
            'MATCH_APPROVED',
            'MATCH_CANCELLED',
            'MATCH_COMPLETED',
            'DONOR_VERIFICATION_CHANGED',
            'RECEIVER_WAITLIST_CHANGED',
            'POLICY_VERSION_CHANGED'
        ]
    },
    Actor: {
        userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital' },
        role: String
    },
    TargetType: {
        type: String,
        enum: ['Match', 'Donor', 'Receiver', 'Policy']
    },
    TargetId: { type: mongoose.Schema.Types.ObjectId },
    RequestId: String,
    At: { type: Date, default: Date.now },
    // Free-form payload. Kept Mixed so the per-event shapes can evolve without
    // schema migrations — see the audit section of the plan for the contract.
    Payload: mongoose.Schema.Types.Mixed,
    HospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital' },
    IpAddress: String,
    UserAgent: String
}, { timestamps: true });

// Hospital-scoped recent history (dashboards).
auditLogSchema.index({ HospitalId: 1, At: -1 });
// "What happened to this match?" reconstruction.
auditLogSchema.index({ TargetType: 1, TargetId: 1, At: -1 });
// Recent events by type (e.g. all MATCH_CANCELLED in the last 24h).
auditLogSchema.index({ Event: 1, At: -1 });

module.exports = mongoose.model('AuditLog', auditLogSchema);