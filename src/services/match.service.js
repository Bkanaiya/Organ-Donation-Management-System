const mongoose = require('mongoose');
const AppError = require('../utils/AppError');
const Donor = require('../models/donor.model');
const Receiver = require('../models/receiver.model');
const Match = require('../models/match.model');
const Crossmatch = require('../models/crossmatch.model');
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

// An organ entry is allocatable when it is in an active allocatable status.
// Organs listed on the donor (e.g. a second kidney) can be individually
// withdrawn, routed to research, or already harvested — and only the
// allocatable entry may be scored, reserved, or have its ischemia clock read.
const ALLOCATABLE_ORGAN_STATUSES = ['available', 'verified'];

function findAllocatableOrganEntry(donor, organ) {
    if (!donor || !Array.isArray(donor.OrgansDonated)) return undefined;
    return donor.OrgansDonated.find((o) => o.Organ === organ && ALLOCATABLE_ORGAN_STATUSES.includes(o.Status));
}

// PII-minimal view of a candidate donor. Intentionally omits Name,
// ContactNumber, Email, MedicalHistory. Hospital is just the populated
// { _id, Name } — never the full address/contact.
//
// `requiresTransfer` is true when the donor's hospital differs from the
// receiver's hospital — even though /suggest no longer filters by hospital
// (organ matching is regional/national), cross-hospital allocation requires
// an inter-hospital transfer, which the UI must surface so a coordinator
// can confirm a transport plan before approving.
function minimalCandidateView(donor, organEntry, score, evalResult, receiver) {
    const donorHospitalId = donor.Hospital && donor.Hospital._id
        ? donor.Hospital._id.toString()
        : null;
    const receiverHospitalId = receiver && receiver.Hospital
        ? receiver.Hospital.toString()
        : null;
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
        scoreBreakdown: sanitizedBreakdown(score.breakdown),
        flags: evalResult.flags,
        requiresTransfer: !!donorHospitalId && !!receiverHospitalId && donorHospitalId !== receiverHospitalId
    };
}

// Score-breakdown view safe to return to suggest callers. Drops the raw
// `factors` block entirely — it carries exact donor/receiver ages, raw HLA
// antigen counts, and other clinical inputs that the "minimal view" contract
// must not leak to a coordinator who has only seen an age band. The aggregated
// 0..100 sub-scores (location, urgency, waitingTime, ...) stay so the ranking
// stays explainable, and policyVersion/weights identify which policy produced
// the number. The full breakdown is still stored on the Match and in the
// audit row for post-hoc review.
function sanitizedBreakdown(breakdown) {
    if (!breakdown) return undefined;
    const { factors, ...publicBreakdown } = breakdown;
    return publicBreakdown;
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
async function suggestMatchesForReceiver(receiverId, callerHospitalId, req, limitParam) {
    // A malformed id is indistinguishable from a missing one — return 404, not
    // 500. CastError enumeration would tell a caller the id format was wrong.
    if (!mongoose.Types.ObjectId.isValid(receiverId)) {
        throw new AppError('receiver not found', 404);
    }

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

    // Suggestion must consider donors from every hospital, not just the
    // caller's — organ matching is a regional / national activity, and a
    // hospital-scoped candidate list would defeat the location factor
    // entirely. Cross-hospital access is still enforced at createMatch time
    // (the receiver's hospital must equal the donor's hospital OR the
    // caller must be an admin) and a `requiresTransfer: true` flag is
    // surfaced here so the UI can show "transfer required" for any
    // candidate from another hospital.
    const query = {
        IsVerified: true,
        ConsentGiven: true,
        Status: { $in: ['available', 'verified'] },
        BloodGroup: { $in: compatibleBloodGroups },
        OrgansDonated: {
            // Match the same allocatable statuses the eligibility engine
            // accepts (ALLOCATABLE_ORGAN_STATUSES) — not just 'available'. A
            // 'verified' organ is scored and reservable everywhere else; if
            // this query dropped it, suggestions would silently omit an organ
            // the whole scoring/eligibility stack treats as live.
            $elemMatch: { Organ: receiver.Organ_needed, Status: { $in: ALLOCATABLE_ORGAN_STATUSES } }
        }
    };

    const candidates = await Donor.find(query).populate('Hospital', 'Name State District');

    const now = new Date();
    const ranked = candidates
        .map((donor) => {
            // Use the ALLOCATABLE organ entry (not just any entry for the
            // organ). The query already restricts to a 'available' entry via
            // $elemMatch, but a donor can list the same organ twice (e.g. two
            // kidneys) with one withdrawn; without this the raw find() would
            // score the withdrawn entry and rank it as a live candidate.
            const organEntry = findAllocatableOrganEntry(donor, receiver.Organ_needed);
            const evalResult = evaluateDonorOrganForReceiver(donor, organEntry, receiver, receiver.Organ_needed, policy, now);
            const score = scoreMatch(donor, organEntry, receiver, receiver.Organ_needed, policy, now);
            return { donor, organEntry, score, evalResult };
        })
        .filter((c) => c.evalResult.eligible)             // strict mode
        .sort((a, b) => b.score.total - a.score.total)    // explainable priority
        .map(({ donor, organEntry, score, evalResult }) => minimalCandidateView(donor, organEntry, score, evalResult, receiver));

    // Caller-supplied cap on the response size. Suggestion is a ranking view;
    // a coordinator only reviews the top of it, and shipping every eligible
    // candidate (potentially the whole regional waitlist) is wasteful. The
    // controller clamps the raw query value; this service default keeps the
    // API useful even when the query param is absent.
    const limit = clampLimit(limitParam);
    const paginated = limit > 0 ? ranked.slice(0, limit) : ranked;

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
            candidateCount: paginated.length,
            eligibleCandidateCount: ranked.length,
            requestedLimit: limitParam != null ? limitParam : null,
            donorIds: paginated.map((c) => c.donorId),
            policyVersion: policy.version
        }
    });

    return {
        receiver: minimalReceiver(receiver),
        compatibleBloodGroups,
        count: paginated.length,
        candidates: paginated,
        scoring: { policyVersion: policy.version, weights: policy.scoreWeights }
    };
}

// Normalizes a caller-supplied suggest limit to an integer in [1, 200].
// Non-numeric garbage, 0, and negatives fall back to the default (50).
const DEFAULT_SUGGEST_LIMIT = 50;
const MAX_SUGGEST_LIMIT = 200;
function clampLimit(value) {
    const n = typeof value === 'string' ? Number(value) : value;
    if (typeof n !== 'number' || !Number.isFinite(n)) return DEFAULT_SUGGEST_LIMIT;
    const floor = Math.floor(n);
    if (floor < 1) return DEFAULT_SUGGEST_LIMIT;
    return Math.min(floor, MAX_SUGGEST_LIMIT);
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

            // Pick the ALLOCATABLE organ entry, not just any entry for the
            // organ. A donor can list the same organ twice (e.g. two kidneys)
            // with the second withdrawn or routed to research; scoring and the
            // CAS must target the live 'available' entry, never the withdrawn
            // one. The fallback keeps the pre-eligibility error specific — but
            // if it IS a withdrawn entry, eligibility's organ-status rule
            // throws 409 before anything is reserved.
            const organEntry = findAllocatableOrganEntry(donor, Organ) || donor.OrgansDonated.find((o) => o.Organ === Organ);
            if (!organEntry) {
                throw new AppError(`donor has not offered ${Organ}`, 400);
            }
            // Stable identity of the exact entry being reserved. A donor can
            // list the same organ twice (two kidneys); the CAS below and every
            // later release/complete write must target THIS entry by id, never
            // "the first row whose Organ equals the name".
            const organEntryId = organEntry && organEntry._id;

            // Defense in depth: a hospital-role caller has already been scoped by
            // `scopeToHospital`, so the controller passes the live Hospital id.
            // The Match is recorded under the receiver's (transplanting)
            // hospital, so a scoped caller may only reserve for a receiver at
            // their own hospital. The donor is allowed to come from any other
            // hospital — allocation is regional/national, and `requiresTransfer`
            // is surfaced at suggest time so a coordinator can plan transport.
            // If the receiver is at a different hospital, reject here too — the
            // service never trusts a body-supplied hospitalId when scoped
            // callers are involved. Admins may pass any hospital as long as it
            // is the receiver's.
            if (hospitalId) {
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
            // requires the entry to still be allocatable — if a concurrent
            // transaction got there first, this update returns null and we
            // abort with 409. The accepted statuses mirror the eligibility
            // engine (ALLOCATABLE_ORGAN_STATUSES): a 'verified' organ passes
            // every clinical gate, so it must be reservable here too.
            //
            // IschemiaStartedAt is the *clinically recorded procurement
            // timestamp* and must not be overwritten here. Setting it to
            // `now` would reset the cold-ischemia clock at reservation
            // time, making a freshly-reserved organ look like it has its
            // full preservation budget left even when procurement was
            // hours ago. We only stamp it when the donor organ has no
            // recorded procurement time (the donor hasn't been procured
            // yet — e.g. a living donor scheduled for retrieval).
            const setOps = {
                'OrgansDonated.$.Status': 'matched',
                'OrgansDonated.$.ColdIschemiaLimit_min': policy.coldIschemiaLimit_min
            };
            if (!organEntry.IschemiaStartedAt) {
                setOps['OrgansDonated.$.IschemiaStartedAt'] = now;
            }
            const reserved = await Donor.findOneAndUpdate(
                { _id: donorId,
                  OrgansDonated: { $elemMatch: { Organ, Status: { $in: ALLOCATABLE_ORGAN_STATUSES } } },
                  // Pin the positional $ to the exact entry we scored. The
                  // entry must still be allocatable (via $elemMatch) so a
                  // concurrent reservation of the SAME entry still loses the
                  // CAS. Without the id, $ would target the first row sharing
                  // the organ name — wrong when a donor lists it twice.
                  ...(organEntryId ? { 'OrgansDonated._id': organEntryId } : {}) },
                { $set: setOps },
                { session, returnDocument: 'after' }
            );
            if (!reserved) {
                throw new AppError('organ no longer available', 409);
            }

            // 4. Conditional flip of the receiver. The status must still be in
            // the policy's accepted list — fails closed if it was already moved.
            // Capture the pre-match status first so a later cancel can restore
            // the receiver exactly (kidney comes from 'waiting', but tissue
            // policies can match a 'verified' receiver).
            const receiverStatusBeforeMatch = receiver.Status;
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
            //
            // ColdIschemiaStartedAt is the donor's recorded procurement time
            // (or `now` if the donor hadn't been procured yet, in which case
            // step 3 just stamped it). We read the value we KNOW step 3
            // produced — `organEntry.IschemiaStartedAt || now` — instead of
            // re-scanning `reserved` for "the" entry: a donor with duplicate
            // organ rows made that re-scan pick the wrong (withdrawn) row.
            const initialPhase = policy.workflow[1] || 'reserved';
            const coldIschemiaStartedAt = organEntry.IschemiaStartedAt || now;
            const procuredBeforeMatch = !!organEntry.IschemiaStartedAt;
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
                ColdIschemiaStartedAt: coldIschemiaStartedAt,
                MaxColdIschemia_min: policy.coldIschemiaLimit_min,
                ProcuredBeforeMatch: procuredBeforeMatch,
                OrganEntryId: organEntryId,
                ReceiverStatusBeforeMatch: receiverStatusBeforeMatch,
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
        // The unique partial index on {Receiver} enforces the one-open-match
        // rule atomically. Two concurrent createMatch calls for the same
        // receiver both pass the in-memory guard; the second insert hits the
        // index and aborts its transaction with E11000.
        if (err && (err.code === 11000 || err.codeName === 'DuplicateKey')) {
            throw new AppError('receiver is already on an open match', 409);
        }
        throw err;
    } finally {
        session.endSession();
    }
}

// Allocation-lifecycle helpers ------------------------------------------------

// Centralised state-machine for the per-organ workflow. The allowed
// `next` phase for any given `current` phase is derived from the policy's
// declared `workflow` array. Anything not on the path is rejected so a
// stale UI or a buggy client cannot jump the organ straight to
// `completed` and silently bypass `accepted` / `in_progress` (and the audit
// trail that goes with them).
function nextPhaseFor(policy, current) {
    if (current === 'cancelled' || current === 'failed' || current === 'completed') {
        return null;     // terminal
    }
    const order = policy.workflow || [];
    const i = order.indexOf(current);
    if (i < 0 || i + 1 >= order.length) return null;
    return order[i + 1];
}

function assertPhaseTransitionAllowed(policy, fromPhase, toPhase) {
    if (toPhase === 'cancelled' || toPhase === 'failed') return;     // terminal exits are always allowed
    const allowed = nextPhaseFor(policy, fromPhase);
    if (allowed !== toPhase) {
        throw new AppError(`illegal phase transition: ${fromPhase} -> ${toPhase} for organ policy ${policy.version}`, 409);
    }
}

// Builds the Donor filter that pinpoints the EXACT organ subdoc a match owns.
// New matches capture the reserved entry's _id in OrganEntryId, so release and
// complete target it directly — never "the first row whose Organ equals the
// name", which a donor listing the same organ twice (two kidneys) would make
// resolve to the wrong entry. Legacy rows without an OrganEntryId fall back
// to the organ-name positional filter, preserving the old release behavior.
function donorOrganEntryFilter(match) {
    return match.OrganEntryId
        ? { _id: match.Donor, 'OrgansDonated._id': match.OrganEntryId }
        : { _id: match.Donor, 'OrgansDonated.Organ': match.Organ };
}

// Reverses the side effects of createMatch so a cancel/fail actually frees
// the donor organ and the receiver for the next round. The receiver is
// restored to the exact status they held when this match was created: the
// create path captures it in `ReceiverStatusBeforeMatch`. Kidney-style
// policies always match from 'waiting', but tissue policies (cornea/skin/
// bone/valve) accept ['verified', 'waiting'] and can flip a 'verified'
// receiver to 'matched' — restoring them to 'waiting' would silently demote
// them. The reverse is only unambiguous when the captured field exists, so a
// legacy match without it gets the donor organ freed but the receiver left
// untouched: guessing would risk demoting a 'verified' receiver or promoting
// a 'pending' one, and there is no backfill data to recover the true status.
async function releaseMatchSideEffects({ session, match, reason }) {
    // Donor organ back to 'available', and clear reserved fields so a future
    // match starts from a clean view. IschemiaStartedAt is only cleared for
    // pre-procurement matches — the one whose reservation stamped the clock
    // (ProcuredBeforeMatch === false). A genuinely procured organ keeps its
    // recorded procurement time: the clock measures REAL preservation time,
    // so a canceled match must not pretend a procured organ was never
    // procured (that would hand the next match a full ischemia budget on a
    // kidney already hours into its 24h limit).
    const donorSet = {
        'OrgansDonated.$.Status': 'available',
        'OrgansDonated.$.ColdIschemiaLimit_min': null
    };
    if (match.ProcuredBeforeMatch === false) {
        donorSet['OrgansDonated.$.IschemiaStartedAt'] = null;
    }
    const donorUpdate = await Donor.updateOne(
        donorOrganEntryFilter(match),
        { $set: donorSet },
        { session }
    );
    if (donorUpdate.matchedCount !== 1) {
        // The donor was deleted out from under the match — log but don't
        // fail the cancel. The Match row still flips to terminal.
        logger.warn({ matchId: match._id, donorId: match.Donor }, 'donor not found while releasing match');
    }
    if (!match.ReceiverStatusBeforeMatch) {
        logger.warn({ matchId: match._id, receiverId: match.Receiver, reason }, 'legacy match without ReceiverStatusBeforeMatch; leaving receiver status untouched');
        return;
    }
    // Receiver back to the waitlist state they were in at match creation.
    // 'matched' is the only status the create path sets, so the reverse is
    // unambiguous once the captured field is present.
    const receiverUpdate = await Receiver.updateOne(
        { _id: match.Receiver, Status: 'matched' },
        { $set: { Status: match.ReceiverStatusBeforeMatch } },
        { session }
    );
    if (receiverUpdate.matchedCount !== 1) {
        logger.warn({ matchId: match._id, receiverId: match.Receiver, reason }, 'receiver not in matched status while releasing match');
    }
}

// Loads a Match and enforces the hospital-scope of the caller. Admins skip
// the scope check; hospital users can only touch matches at their hospital.
async function loadMatchForCaller(matchId, callerHospitalId) {
    const match = await Match.findById(matchId);
    if (!match) {
        throw new AppError('match not found', 404);
    }
    if (callerHospitalId && match.Hospital && match.Hospital.toString() !== callerHospitalId) {
        throw new AppError('match belongs to a different hospital', 403);
    }
    return match;
}

// Approve a reserved match — moves to the next policy phase (typically
// 'crossmatch_confirmed' for kidney/marrow, 'accepted' otherwise). Writes
// an audit row inside the same transaction.
async function approveMatch(matchId, user, req) {
    const session = await mongoose.startSession();
    try {
        return await session.withTransaction(async () => {
            const match = await Match.findById(matchId).session(session);
            if (!match) {
                throw new AppError('match not found', 404);
            }
            if (user && user.Hospital && match.Hospital && match.Hospital.toString() !== user.Hospital) {
                throw new AppError('match belongs to a different hospital', 403);
            }
            const policy = getOrganPolicy(match.Organ);
            const next = nextPhaseFor(policy, match.AllocationPhase);
            if (!next) {
                throw new AppError(`cannot approve match in terminal phase ${match.AllocationPhase}`, 409);
            }
            if (next === 'in_progress' || next === 'completed') {
                // The state machine should never reach in_progress directly
                // from 'reserved' / 'crossmatch_confirmed' / 'accepted' for
                // any current policy, but guard it for future workflow edits.
                throw new AppError(`illegal phase transition: ${match.AllocationPhase} -> ${next}`, 409);
            }
            // Advancing INTO crossmatch_confirmed is the lab-confirmation
            // step: it must be driven by an actual recorded negative
            // crossmatch for this exact donor-receiver-organ pair (see
            // recordCrossmatch), not by a generic approve. The Crossmatch
            // doc is pair-specific, so a negative result for another
            // receiver never counts here.
            //
            // The negative must also be from the CURRENT cycle: after any
            // positive result for the pair, only a negative recorded LATER
            // than that positive (or, with no positives ever, after this
            // match started) clears the pair. This is what stops a stale
            // negative from a previous allocation cycle being reused to
            // confirm a re-match that a new sensitization already voided.
            if (next === 'crossmatch_confirmed') {
                const lastPositive = await Crossmatch.findOne({
                    Donor: match.Donor,
                    Receiver: match.Receiver,
                    Organ: match.Organ,
                    Result: 'positive'
                }).sort({ TestedAt: -1, _id: -1 }).session(session);
                const since = lastPositive ? lastPositive.TestedAt : match.MatchedDate;
                const confirmed = await Crossmatch.findOne({
                    Donor: match.Donor,
                    Receiver: match.Receiver,
                    Organ: match.Organ,
                    Result: 'negative',
                    TestedAt: { $gte: since }
                }).session(session);
                if (!confirmed) {
                    throw new AppError('a negative crossmatch from the current cycle is required before this match can be confirmed', 409);
                }
            }
            const now = new Date();
            const updated = await Match.findOneAndUpdate(
                { _id: matchId, AllocationPhase: match.AllocationPhase },
                { $set: {
                    AllocationPhase: next,
                    Status: next === 'in_progress' ? 'in_progress' : 'approved',
                    ApprovedBy: user && (user.id || user._id),
                    ApprovedAt: now
                }},
                { session, returnDocument: 'after' }
            );
            if (!updated) {
                throw new AppError('match phase changed concurrently', 409);
            }
            await AuditLog.create([{
                Event: 'MATCH_APPROVED',
                Actor: { userId: user && (user.id || user._id), hospitalId: user && user.Hospital, role: user && user.Role },
                TargetType: 'Match',
                TargetId: match._id,
                RequestId: user && user.requestId,
                HospitalId: match.Hospital,
                Payload: { from: match.AllocationPhase, to: next, policyVersion: policy.version }
            }], { session });
            return updated;
        }, { readConcern: { level: 'majority' }, writeConcern: { w: 'majority' } });
    } finally {
        session.endSession();
    }
}

// Record the lab crossmatch for a reserved match and advance (or cancel) the
// workflow accordingly.
//
// A crossmatch is donor-recipient-PAIR-specific: the lab mixes THIS receiver's
// serum with THIS donor's cells. The Crossmatch doc is keyed on
// (Donor, Receiver, Organ) — so a negative result for one receiver can never
// clear the organ for another. `Result` is final ('negative' | 'positive');
// results are APPEND-ONLY, so a re-test adds a new row dated by TestedAt
// rather than rewriting the old one. History is what lets a later re-match of
// a previously-positive pair prove it has a FRESH negative (see approveMatch).
//
// Workflow effect:
//   negative → phase reserved -> crossmatch_confirmed (lab cleared the pair)
//   positive → the match is CANCELLED: the donor organ and receiver are
//              released back into the pool, and the positive result stays on
//              record so a later re-allocation of this organ to THIS receiver
//              requires a fresh negative before the next match can confirm.
async function recordCrossmatch(matchId, { Result, Method, Notes }, user, req) {
    if (Result !== 'negative' && Result !== 'positive') {
        throw new AppError('crossmatch Result must be negative or positive', 400);
    }
    const session = await mongoose.startSession();
    try {
        return await session.withTransaction(async () => {
            const match = await Match.findById(matchId).session(session);
            if (!match) {
                throw new AppError('match not found', 404);
            }
            if (user && user.Hospital && match.Hospital && match.Hospital.toString() !== user.Hospital) {
                throw new AppError('match belongs to a different hospital', 403);
            }
            const policy = getOrganPolicy(match.Organ);
            if (!policy.crossmatchRequired) {
                throw new AppError(`crossmatch is not required by the ${match.Organ} policy`, 400);
            }
            if (match.AllocationPhase !== 'reserved' && match.AllocationPhase !== 'crossmatch_confirmed') {
                throw new AppError(`cannot record crossmatch on match in phase ${match.AllocationPhase}`, 409);
            }

            // Append a new result — the crossmatch table is a history, not a
            // single mutable row. A pair can legitimately produce several
            // results over time (an initial negative, a later positive after
            // sensitization, a re-test before transplant); each gets its own
            // row ordered by TestedAt. An upsert here would collapse that
            // history to the latest result, which is exactly what lets a
            // previously-positive pair be re-matched and re-confirmed on a
            // stale negative.
            const [crossmatch] = await Crossmatch.create([{
                Donor: match.Donor,
                Receiver: match.Receiver,
                Organ: match.Organ,
                Result,
                Method: Method || 'flow_cytometry',
                TestedAt: new Date(),
                TestedBy: user && (user.id || user._id),
                Notes: Notes || undefined
            }], { session });

            let updatedMatch;
            if (Result === 'positive') {
                // Terminal exit — release the organ and receiver, same side
                // effects as a manual cancel.
                updatedMatch = await Match.findOneAndUpdate(
                    { _id: matchId, AllocationPhase: match.AllocationPhase },
                    { $set: {
                        AllocationPhase: 'cancelled',
                        Status: 'cancelled',
                        CancelledBy: user && (user.id || user._id),
                        CancelledAt: new Date(),
                        CancellationReason: 'crossmatch positive'
                    }},
                    { session, returnDocument: 'after' }
                );
                if (!updatedMatch) {
                    throw new AppError('match phase changed concurrently', 409);
                }
                await releaseMatchSideEffects({ session, match: updatedMatch, reason: 'crossmatch positive' });
                await AuditLog.create([{
                    Event: 'MATCH_CANCELLED',
                    Actor: { userId: user && (user.id || user._id), hospitalId: user && user.Hospital, role: user && user.Role },
                    TargetType: 'Match',
                    TargetId: match._id,
                    RequestId: user && user.requestId,
                    HospitalId: match.Hospital,
                    Payload: { from: match.AllocationPhase, to: 'cancelled', reason: 'crossmatch positive', policyVersion: policy.version }
                }], { session });
            } else {
                // Negative — the pair is confirmed, advance the workflow.
                const next = policy.workflow.includes('crossmatch_confirmed')
                    ? 'crossmatch_confirmed'
                    : nextPhaseFor(policy, match.AllocationPhase);
                if (!next) {
                    throw new AppError(`cannot advance match from terminal phase ${match.AllocationPhase}`, 409);
                }
                updatedMatch = await Match.findOneAndUpdate(
                    { _id: matchId, AllocationPhase: match.AllocationPhase },
                    { $set: {
                        AllocationPhase: next,
                        Status: next === 'in_progress' ? 'in_progress' : 'approved',
                        ApprovedBy: user && (user.id || user._id),
                        ApprovedAt: new Date()
                    }},
                    { session, returnDocument: 'after' }
                );
                if (!updatedMatch) {
                    throw new AppError('match phase changed concurrently', 409);
                }
            }

            await AuditLog.create([{
                Event: 'CROSSMATCH_RECORDED',
                Actor: { userId: user && (user.id || user._id), hospitalId: user && user.Hospital, role: user && user.Role },
                TargetType: 'Match',
                TargetId: match._id,
                RequestId: user && user.requestId,
                HospitalId: match.Hospital,
                Payload: {
                    donorId: match.Donor,
                    receiverId: match.Receiver,
                    organ: match.Organ,
                    result: Result,
                    method: crossmatch.Method,
                    phase: updatedMatch.AllocationPhase,
                    policyVersion: policy.version
                }
            }], { session });

            return { crossmatch, match: updatedMatch };
        }, { readConcern: { level: 'majority' }, writeConcern: { w: 'majority' } });
    } catch (err) {
        if (err && err.codeName === 'WriteConflict') {
            throw new AppError('concurrent match attempt', 409);
        }
        throw err;
    } finally {
        session.endSession();
    }
}

// Mark a match as in-progress (transplant surgery has begun). Phase must
// currently be 'accepted' for the transition to be valid.
async function startMatch(matchId, user, req) {
    const session = await mongoose.startSession();
    try {
        return await session.withTransaction(async () => {
            const match = await Match.findById(matchId).session(session);
            if (!match) {
                throw new AppError('match not found', 404);
            }
            if (user && user.Hospital && match.Hospital && match.Hospital.toString() !== user.Hospital) {
                throw new AppError('match belongs to a different hospital', 403);
            }
            const policy = getOrganPolicy(match.Organ);
            assertPhaseTransitionAllowed(policy, match.AllocationPhase, 'in_progress');
            const now = new Date();
            const updated = await Match.findOneAndUpdate(
                { _id: matchId, AllocationPhase: match.AllocationPhase },
                { $set: {
                    AllocationPhase: 'in_progress',
                    Status: 'in_progress'
                }},
                { session, returnDocument: 'after' }
            );
            if (!updated) {
                throw new AppError('match phase changed concurrently', 409);
            }
            await AuditLog.create([{
                Event: 'MATCH_STARTED',
                Actor: { userId: user && (user.id || user._id), hospitalId: user && user.Hospital, role: user && user.Role },
                TargetType: 'Match',
                TargetId: match._id,
                RequestId: user && user.requestId,
                HospitalId: match.Hospital,
                Payload: { from: match.AllocationPhase, to: 'in_progress', policyVersion: policy.version }
            }], { session });
            return updated;
        }, { readConcern: { level: 'majority' }, writeConcern: { w: 'majority' } });
    } finally {
        session.endSession();
    }
}

// Complete a match — terminal success. Mark the donor organ as 'donated'
// and the receiver as 'transplanted' so post-match reports reflect reality.
async function completeMatch(matchId, user, req) {
    const session = await mongoose.startSession();
    try {
        return await session.withTransaction(async () => {
            const match = await Match.findById(matchId).session(session);
            if (!match) {
                throw new AppError('match not found', 404);
            }
            if (user && user.Hospital && match.Hospital && match.Hospital.toString() !== user.Hospital) {
                throw new AppError('match belongs to a different hospital', 403);
            }
            const policy = getOrganPolicy(match.Organ);
            assertPhaseTransitionAllowed(policy, match.AllocationPhase, 'completed');
            const now = new Date();
            const updated = await Match.findOneAndUpdate(
                { _id: matchId, AllocationPhase: match.AllocationPhase },
                { $set: {
                    AllocationPhase: 'completed',
                    Status: 'completed',
                    CompletedDate: now
                }},
                { session, returnDocument: 'after' }
            );
            if (!updated) {
                throw new AppError('match phase changed concurrently', 409);
            }
            // Donor organ terminal state, donor terminal state, receiver
            // terminal state. The top-level donor.Status moves to 'donated' so
            // donor-level reports and eligibility queries stop offering this
            // donor entirely (the organ subdoc alone would leave the donor doc
            // looking 'available' at the top level).
            await Donor.updateOne(
                donorOrganEntryFilter(match),
                { $set: { 'OrgansDonated.$.Status': 'donated', Status: 'donated' }},
                { session }
            );
            await Receiver.updateOne(
                { _id: match.Receiver },
                { $set: { Status: 'transplanted' } },
                { session }
            );
            await AuditLog.create([{
                Event: 'MATCH_COMPLETED',
                Actor: { userId: user && (user.id || user._id), hospitalId: user && user.Hospital, role: user && user.Role },
                TargetType: 'Match',
                TargetId: match._id,
                RequestId: user && user.requestId,
                HospitalId: match.Hospital,
                Payload: { from: match.AllocationPhase, to: 'completed', policyVersion: policy.version }
            }], { session });
            return updated;
        }, { readConcern: { level: 'majority' }, writeConcern: { w: 'majority' } });
    } finally {
        session.endSession();
    }
}

// Cancel a match — terminal exit that releases the donor organ and the
// receiver back into the pool. Safe to call from any non-terminal phase.
async function cancelMatch(matchId, user, reason, req) {
    if (!reason || typeof reason !== 'string' || !reason.trim()) {
        throw new AppError('cancellation reason is required', 400);
    }
    const session = await mongoose.startSession();
    try {
        return await session.withTransaction(async () => {
            const match = await Match.findById(matchId).session(session);
            if (!match) {
                throw new AppError('match not found', 404);
            }
            if (user && user.Hospital && match.Hospital && match.Hospital.toString() !== user.Hospital) {
                throw new AppError('match belongs to a different hospital', 403);
            }
            const policy = getOrganPolicy(match.Organ);
            if (match.AllocationPhase === 'cancelled' || match.AllocationPhase === 'completed' || match.AllocationPhase === 'failed') {
                throw new AppError(`cannot cancel a match in terminal phase ${match.AllocationPhase}`, 409);
            }
            const fromPhase = match.AllocationPhase;
            const updated = await Match.findOneAndUpdate(
                { _id: matchId, AllocationPhase: fromPhase },
                { $set: {
                    AllocationPhase: 'cancelled',
                    Status: 'cancelled',
                    CancelledBy: user && (user.id || user._id),
                    CancelledAt: new Date(),
                    CancellationReason: reason
                }},
                { session, returnDocument: 'after' }
            );
            if (!updated) {
                throw new AppError('match phase changed concurrently', 409);
            }
            await releaseMatchSideEffects({ session, match, reason });
            await AuditLog.create([{
                Event: 'MATCH_CANCELLED',
                Actor: { userId: user && (user.id || user._id), hospitalId: user && user.Hospital, role: user && user.Role },
                TargetType: 'Match',
                TargetId: match._id,
                RequestId: user && user.requestId,
                HospitalId: match.Hospital,
                Payload: { from: fromPhase, to: 'cancelled', reason, policyVersion: policy.version }
            }], { session });
            return updated;
        }, { readConcern: { level: 'majority' }, writeConcern: { w: 'majority' } });
    } finally {
        session.endSession();
    }
}

// Fail a match — terminal exit for matches that die at the clinical stage
// (organ unusable at retrieval, recipient decompensates). Distinct from
// cancel: cancel is a planner-side withdrawal and writes CancellationReason /
// MATCH_CANCELLED, while a failure is a clinical outcome and writes
// FailureReason / MATCH_FAILED. Side effects are identical to cancel — the
// donor organ and receiver go back into the pool.
async function failMatch(matchId, user, reason, req) {
    if (!reason || typeof reason !== 'string' || !reason.trim()) {
        throw new AppError('failure reason is required', 400);
    }
    const session = await mongoose.startSession();
    try {
        return await session.withTransaction(async () => {
            const match = await Match.findById(matchId).session(session);
            if (!match) {
                throw new AppError('match not found', 404);
            }
            if (user && user.Hospital && match.Hospital && match.Hospital.toString() !== user.Hospital) {
                throw new AppError('match belongs to a different hospital', 403);
            }
            const policy = getOrganPolicy(match.Organ);
            if (match.AllocationPhase === 'cancelled' || match.AllocationPhase === 'completed' || match.AllocationPhase === 'failed') {
                throw new AppError(`cannot fail a match in terminal phase ${match.AllocationPhase}`, 409);
            }
            const fromPhase = match.AllocationPhase;
            const updated = await Match.findOneAndUpdate(
                { _id: matchId, AllocationPhase: fromPhase },
                { $set: {
                    AllocationPhase: 'failed',
                    Status: 'failed',
                    FailedBy: user && (user.id || user._id),
                    FailedAt: new Date(),
                    FailureReason: reason
                }},
                { session, returnDocument: 'after' }
            );
            if (!updated) {
                throw new AppError('match phase changed concurrently', 409);
            }
            await releaseMatchSideEffects({ session, match, reason });
            await AuditLog.create([{
                Event: 'MATCH_FAILED',
                Actor: { userId: user && (user.id || user._id), hospitalId: user && user.Hospital, role: user && user.Role },
                TargetType: 'Match',
                TargetId: match._id,
                RequestId: user && user.requestId,
                HospitalId: match.Hospital,
                Payload: { from: fromPhase, to: 'failed', reason, policyVersion: policy.version }
            }], { session });
            return updated;
        }, { readConcern: { level: 'majority' }, writeConcern: { w: 'majority' } });
    } finally {
        session.endSession();
    }
}
// their own hospital's matches; admins see everything.
//
// `status` accepts either the AllocationPhase value ('reserved', 'accepted',
// 'in_progress', ...) or the legacy Status value it supersedes. The legacy
// enum predates the per-organ workflow and is coarser — 'pending' (reserved),
// 'approved' (crossmatch_confirmed/accepted) — so legacy values are translated
// to the phase(s) that match modern rows. Without the translation a client
// still querying by `?status=approved` would silently match nothing.
const LEGACY_STATUS_TO_PHASE = {
    pending: 'reserved',
    approved: { $in: ['crossmatch_confirmed', 'accepted'] }
};

async function listMatches({ callerHospitalId, status, organ, limit = 50 }) {
    const query = {};
    if (callerHospitalId) query.Hospital = callerHospitalId;
    if (status) {
        query.AllocationPhase = LEGACY_STATUS_TO_PHASE[status] || status;
    }
    if (organ) query.Organ = organ;
    return Match.find(query)
        .sort({ MatchedDate: -1 })
        .limit(Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200));
}

// Full audit trail for a match: every MATCH_* event referencing it, newest
// first. The match itself is scope-checked first (a hospital user can only
// audit their own hospital's matches), then the audit rows are returned so a
// coordinator can reconstruct who reserved, approved, started, completed, or
// cancelled a match and when.
async function getMatchAuditTrail(matchId, callerHospitalId) {
    await loadMatchForCaller(matchId, callerHospitalId);
    return AuditLog.find({
        TargetType: 'Match',
        TargetId: matchId
    }).sort({ At: -1, _id: -1 });
}

module.exports = {
    suggestMatchesForReceiver,
    createMatch,
    approveMatch,
    recordCrossmatch,
    startMatch,
    completeMatch,
    cancelMatch,
    failMatch,
    listMatches,
    loadMatchForCaller,
    getMatchAuditTrail
};