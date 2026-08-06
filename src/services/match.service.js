const mongoose = require('mongoose');
const AppError = require('../utils/AppError');
const Donor = require('../models/donor.model');
const Receiver = require('../models/receiver.model');
const Match = require('../models/match.model');
const AuditLog = require('../models/auditLog.model');
const { getCompatibleDonorBloodGroups } = require('../utils/matching');
const { getOrganPolicy } = require('../constants/organPolicies');
const { scoreMatch } = require('../utils/scoring');
const { assertDonorOrganAllocatable, evaluateDonorOrganForReceiver } = require('./eligibility.service');
const { logAudit } = require('../utils/auditLogger');
const logger = require('../utils/logger');

// Reduce an age integer to a coarse band — keeps the suggest payload private
// enough to not leak exact ages, while still letting the UI show "30-39".
function ageBand(age) {
    if (age == null) return null;
    const lo = Math.floor(age / 10) * 10;
    return `${lo}-${lo + 9}`;
}

// PII-minimal view of a candidate donor. Intentionally omits Name,
// ContactNumber, Email, MedicalHistory. Hospital is just the populated
// { _id, Name } — never the full address/contact.
function minimalCandidateView(donor, organEntry, score, evalResult) {
    return {
        donorId: donor._id,
        hospitalId: donor.Hospital && donor.Hospital._id,
        hospitalName: donor.Hospital && donor.Hospital.Name,
        organ: organEntry && organEntry.Organ,
        bloodGroup: donor.BloodGroup,
        ageBand: ageBand(donor.Age),
        state: donor.State,
        district: donor.District,
        matchQuality: score.breakdown.factors.distanceBand,
        score: score.total,
        scoreBreakdown: score.breakdown,
        flags: evalResult.flags
    };
}

// PII-minimal view of the receiver returned in suggest payloads.
function minimalReceiver(receiver) {
    return {
        _id: receiver._id,
        Organ_needed: receiver.Organ_needed,
        BloodGroup: receiver.BloodGroup,
        Urgency: receiver.Urgency,
        WaitlistDate: receiver.WaitlistDate
    };
}

// Finds compatible, available donors for a given receiver: same organ,
// verified + consented + available donor, verified + waiting receiver, ranked
// by an explainable priority score. Returns PII-stripped candidate views —
// full donor PII stays in the donor service until a clinician approves the
// match.
//
// `callerHospitalId` is the DB-resolved id from `req.user.Hospital` (set by
// `scopeToHospital`). When provided, donors from other hospitals are filtered
// out and the receiver must belong to the same hospital. Admins pass no
// `callerHospitalId` and keep a global view.
async function suggestMatchesForReceiver(receiverId, callerHospitalId, req) {
    const receiver = await Receiver.findById(receiverId);

    if (!receiver) {
        throw new AppError('receiver not found', 404);
    }

    if (callerHospitalId && (!receiver.Hospital || receiver.Hospital.toString() !== callerHospitalId)) {
        throw new AppError('receiver belongs to a different hospital', 403);
    }

    // Look up the per-organ policy first so we can use its acceptsReceiverStatuses
    // list — kidney requires 'waiting', cornea accepts 'verified' too.
    let policy;
    try {
        policy = getOrganPolicy(receiver.Organ_needed);
    } catch (err) {
        // If the receiver's needed organ is unknown to the policy registry,
        // we can't safely suggest anything — return an empty payload.
        logger.warn({ receiverId, organ: receiver.Organ_needed }, 'unknown organ in suggest');
        return {
            receiver: minimalReceiver(receiver),
            compatibleBloodGroups: getCompatibleDonorBloodGroups(receiver.BloodGroup),
            count: 0,
            candidates: [],
            explanation: `unknown organ: ${receiver.Organ_needed}`
        };
    }

    if (!receiver.IsVerified || !policy.acceptsReceiverStatuses.includes(receiver.Status)) {
        // Don't leak the receiver's state — return an empty list with a generic
        // explanation so a hospital user can't tell the receiver is pending.
        return {
            receiver: minimalReceiver(receiver),
            compatibleBloodGroups: getCompatibleDonorBloodGroups(receiver.BloodGroup),
            count: 0,
            candidates: [],
            explanation: 'receiver is not currently in an active waitlist state'
        };
    }

    const compatibleBloodGroups = getCompatibleDonorBloodGroups(receiver.BloodGroup);

    const query = {
        IsVerified: true,
        ConsentGiven: true,
        Status: { $in: ['available', 'verified'] },
        BloodGroup: { $in: compatibleBloodGroups },
        OrgansDonated: {
            $elemMatch: { Organ: receiver.Organ_needed, Status: 'available' }
        }
    };
    if (callerHospitalId) {
        query.Hospital = callerHospitalId;
    }

    const candidates = await Donor.find(query).populate('Hospital', 'Name State District');

    const now = new Date();
    const ranked = candidates
        .map((donor) => {
            const organEntry = donor.OrgansDonated.find((o) => o.Organ === receiver.Organ_needed);
            const evalResult = evaluateDonorOrganForReceiver(donor, organEntry, receiver, receiver.Organ_needed, policy, now);
            const score = scoreMatch(donor, organEntry, receiver, receiver.Organ_needed, policy, now);
            return { donor, organEntry, score, evalResult };
        })
        .filter((c) => c.evalResult.eligible)             // strict mode
        .sort((a, b) => b.score.total - a.score.total)    // explainable priority
        .map(({ donor, organEntry, score, evalResult }) => minimalCandidateView(donor, organEntry, score, evalResult));

    // Audit — best effort, outside any transaction. The audit failure must
    // not break the suggest response.
    await logAudit({
        event: 'MATCH_SUGGESTED',
        targetType: 'Receiver',
        targetId: receiver._id,
        hospitalId: callerHospitalId,
        req,
        payload: {
            receiverId: receiver._id,
            organNeeded: receiver.Organ_needed,
            candidateCount: ranked.length,
            donorIds: ranked.map((c) => c.donorId),
            policyVersion: policy.version
        }
    });

    return {
        receiver: minimalReceiver(receiver),
        compatibleBloodGroups,
        count: ranked.length,
        candidates: ranked,
        scoring: { policyVersion: policy.version, weights: policy.scoreWeights }
    };
}

// Creates a match record and reflects it on both sides — the donor's organ
// status moves to "matched" and the receiver's overall status does too, so
// future queries (and /api/match/suggest) don't treat them as still open.
//
// All clinical rules run server-side at confirmation time. The whole flow
// runs inside a MongoDB transaction with majority read/write concern so a
// failure halfway through leaves no partial records. The donor-organ update
// uses a conditional findOneAndUpdate with Status='available' in the filter
// — that's the race-safety net for concurrent match attempts.
async function createMatch({ Donor: donorId, Receiver: receiverId, Organ, Hospital: hospitalId, Notes }, user, req) {
    if (!donorId || !receiverId || !Organ || !hospitalId) {
        throw new AppError('Donor, Receiver, Organ, and Hospital are required', 400);
    }

    // Per-organ policy. Throws AppError(400) if the organ isn't registered.
    const policy = getOrganPolicy(Organ);

    const session = await mongoose.startSession();
    try {
        const match = await session.withTransaction(async () => {
            const donor = await Donor.findById(donorId).session(session);
            if (!donor) {
                throw new AppError('donor not found', 404);
            }
            const receiver = await Receiver.findById(receiverId).session(session);
            if (!receiver) {
                throw new AppError('receiver not found', 404);
            }

            const organEntry = donor.OrgansDonated.find((o) => o.Organ === Organ);
            if (!organEntry) {
                throw new AppError(`donor has not offered ${Organ}`, 400);
            }

            // Defense in depth: a hospital-role caller has already been scoped by
            // `scopeToHospital`, so the controller passes the live Hospital id.
            // If either side of the match belongs to a different hospital,
            // reject here too — so the service never trusts a body-supplied
            // hospitalId when scoped callers are involved. Admins may pass any.
            if (hospitalId) {
                if (!donor.Hospital || donor.Hospital.toString() !== hospitalId) {
                    throw new AppError('donor belongs to a different hospital', 403);
                }
                if (!receiver.Hospital || receiver.Hospital.toString() !== hospitalId) {
                    throw new AppError('receiver belongs to a different hospital', 403);
                }
            }

            // 1. Eligibility — runs every clinical rule. Throws AppError(409)
            // on the first failure so the caller gets a single actionable error.
            assertDonorOrganAllocatable(donor, organEntry, receiver, Organ, policy);

            // 2. Score the (donor, organ, receiver) tuple. The breakdown is
            // stored on the Match and returned to the caller so the decision
            // is auditable later.
            const now = new Date();
            const score = scoreMatch(donor, organEntry, receiver, Organ, policy, now);

            // 3. Conditional reserve of the donor organ (CAS). The filter
            // requires Status='available' — if a concurrent transaction got
            // there first, this update returns null and we abort with 409.
            const reserved = await Donor.findOneAndUpdate(
                { _id: donorId,
                  OrgansDonated: { $elemMatch: { Organ, Status: 'available' } } },
                { $set: {
                    'OrgansDonated.$.Status': 'matched',
                    'OrgansDonated.$.IschemiaStartedAt': now,
                    'OrgansDonated.$.ColdIschemiaLimit_min': policy.coldIschemiaLimit_min
                }},
                { session, new: true }
            );
            if (!reserved) {
                throw new AppError('organ no longer available', 409);
            }

            // 4. Conditional flip of the receiver. The status must still be in
            // the policy's accepted list — fails closed if it was already moved.
            const recUpdated = await Receiver.updateOne(
                { _id: receiverId, Status: { $in: policy.acceptsReceiverStatuses } },
                { $set: { Status: 'matched' } },
                { session }
            );
            if (recUpdated.modifiedCount !== 1) {
                throw new AppError('receiver not eligible for matching', 409);
            }

            // 5. Duplicate-receiver guard: the receiver must not already be on
            // an open match. The compound index in match.model.js backs this
            // lookup; without it the query would scan the collection.
            const existingOpen = await Match.findOne({
                Receiver: receiverId,
                AllocationPhase: { $in: ['reserved', 'crossmatch_confirmed', 'accepted', 'in_progress'] }
            }).session(session);
            if (existingOpen) {
                throw new AppError('receiver is already on an open match', 409);
            }

            // 6. Create the match. We always enter at the second phase of the
            // policy workflow (the first non-suggested phase) so downstream
            // endpoints can advance the phase.
            const initialPhase = policy.workflow[1] || 'reserved';
            const [created] = await Match.create([{
                Donor: donorId,
                Receiver: receiverId,
                Organ,
                Hospital: hospitalId,
                Notes,
                Status: initialPhase === 'reserved' ? 'pending' : 'approved',
                AllocationPhase: initialPhase,
                Score: score.total,
                ScoreBreakdown: score.breakdown,
                PolicyVersion: policy.version,
                OrganPolicySnapshot: policy,
                ColdIschemiaStartedAt: now,
                MaxColdIschemia_min: policy.coldIschemiaLimit_min,
                CreatedBy: user && (user.id || user._id)
            }], { session });

            // 7. Audit row — same session so a transaction abort undoes it.
            await AuditLog.create([{
                Event: 'MATCH_CREATED',
                Actor: { userId: user && (user.id || user._id), hospitalId: user && user.Hospital, role: user && user.Role },
                TargetType: 'Match',
                TargetId: created._id,
                RequestId: user && user.requestId,
                HospitalId: hospitalId,
                Payload: {
                    donorId,
                    receiverId,
                    organ: Organ,
                    score: score.total,
                    breakdown: score.breakdown,
                    policyVersion: policy.version,
                    allocationPhase: initialPhase
                }
            }], { session });

            return created;
        }, { readConcern: { level: 'majority' }, writeConcern: { w: 'majority' } });
        return match;
    } catch (err) {
        if (err && err.codeName === 'WriteConflict') {
            throw new AppError('concurrent match attempt', 409);
        }
        throw err;
    } finally {
        session.endSession();
    }
}

module.exports = { suggestMatchesForReceiver, createMatch };