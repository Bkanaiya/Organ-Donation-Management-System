const AppError = require('../utils/AppError');
const Receiver = require('../models/receiver.model');
const { validateLocation } = require('../utils/location');
const { logAudit } = require('../utils/auditLogger');

// Fields a coordinator may change through PATCH /api/receiver/:id. Clinical
// data entry (HLA, cPRA, size preferences, dialysis history) and contact
// details are allowed; verification (IsVerified/VerifiedBy), waitlist state
// (Status, WaitlistDate), and hospital assignment are deliberately excluded —
// those only change through dedicated, audited workflows. Any other field is
// a 400, not a silent ignore.
const ALLOWED_RECEIVER_UPDATE_FIELDS = [
    'Name', 'ContactNumber', 'Email', 'District',
    'Urgency', 'HLA_Typing', 'cPRA', 'UnacceptableAntigens', 'MELD_score',
    'MELD_ExceptionPoints', 'HeartStatus',
    'SensitizationEvents',
    'AcceptsExtendedCriteria', 'AcceptsPediatricOrgan',
    'MinOrganWeight_grams', 'MaxOrganWeight_grams',
    'DialysisDuration_months', 'BloodAntibodyScreen'
];

const RECEIVER_URGENCIES = ['critical', 'urgent', 'stable'];

// Validate the permitted receiver fields before they touch the DB. Returns a
// clean, type-checked object or throws AppError(400).
function validateReceiverUpdates(existing, updates) {
    const clean = {};
    for (const key of ALLOWED_RECEIVER_UPDATE_FIELDS) {
        if (updates[key] !== undefined) clean[key] = updates[key];
    }

    if (clean.District !== undefined) {
        const location = validateLocation(existing.State, clean.District);
        if (!location.ok) {
            throw new AppError(location.message, location.status);
        }
    }
    if (clean.ContactNumber !== undefined && (typeof clean.ContactNumber !== 'string' || !/^\d{10}$/.test(clean.ContactNumber))) {
        throw new AppError('ContactNumber must be a 10-digit phone number', 400);
    }
    if (clean.Email !== undefined && (typeof clean.Email !== 'string' || !/.+@.+\..+/.test(clean.Email))) {
        throw new AppError('Email must be a valid email address', 400);
    }
    if (clean.Urgency !== undefined && !RECEIVER_URGENCIES.includes(clean.Urgency)) {
        throw new AppError(`Urgency must be one of: ${RECEIVER_URGENCIES.join(', ')}`, 400);
    }
    if (clean.cPRA !== undefined && (typeof clean.cPRA !== 'number' || clean.cPRA < 0 || clean.cPRA > 100)) {
        throw new AppError('cPRA must be a number between 0 and 100', 400);
    }
    if (clean.UnacceptableAntigens !== undefined) {
        if (!Array.isArray(clean.UnacceptableAntigens) || clean.UnacceptableAntigens.some((a) => typeof a !== 'string')) {
            throw new AppError('UnacceptableAntigens must be an array of strings', 400);
        }
    }
    if (clean.MELD_score !== undefined && (typeof clean.MELD_score !== 'number' || clean.MELD_score < 6 || clean.MELD_score > 40)) {
        throw new AppError('MELD_score must be a number between 6 and 40', 400);
    }
    if (clean.MELD_ExceptionPoints !== undefined && (typeof clean.MELD_ExceptionPoints !== 'number' || clean.MELD_ExceptionPoints < 0 || clean.MELD_ExceptionPoints > 34)) {
        throw new AppError('MELD_ExceptionPoints must be a number between 0 and 34', 400);
    }
    if (clean.HeartStatus !== undefined && (typeof clean.HeartStatus !== 'number' || clean.HeartStatus < 1 || clean.HeartStatus > 6)) {
        throw new AppError('HeartStatus must be a number between 1 and 6', 400);
    }
    for (const numField of ['SensitizationEvents', 'DialysisDuration_months', 'MinOrganWeight_grams', 'MaxOrganWeight_grams']) {
        if (clean[numField] !== undefined && (typeof clean[numField] !== 'number' || clean[numField] < 0)) {
            throw new AppError(`${numField} must be a non-negative number`, 400);
        }
    }
    if (clean.MinOrganWeight_grams !== undefined && clean.MaxOrganWeight_grams !== undefined &&
        clean.MinOrganWeight_grams > clean.MaxOrganWeight_grams) {
        throw new AppError('MinOrganWeight_grams cannot exceed MaxOrganWeight_grams', 400);
    }
    for (const boolField of ['AcceptsExtendedCriteria', 'AcceptsPediatricOrgan']) {
        if (clean[boolField] !== undefined && typeof clean[boolField] !== 'boolean') {
            throw new AppError(`${boolField} must be a boolean`, 400);
        }
    }
    if (clean.HLA_Typing !== undefined) {
        const hla = clean.HLA_Typing;
        if (typeof hla !== 'object' || hla === null || Array.isArray(hla)) {
            throw new AppError('HLA_Typing must be an object', 400);
        }
        for (const locus of ['A', 'B', 'DR']) {
            if (hla[locus] !== undefined && (!Array.isArray(hla[locus]) || hla[locus].some((a) => typeof a !== 'string'))) {
                throw new AppError(`HLA_Typing.${locus} must be an array of strings`, 400);
            }
        }
    }
    if (clean.BloodAntibodyScreen !== undefined) {
        const screen = clean.BloodAntibodyScreen;
        if (typeof screen !== 'object' || screen === null || Array.isArray(screen)) {
            throw new AppError('BloodAntibodyScreen must be an object', 400);
        }
        if (screen.latestPRA !== undefined && (typeof screen.latestPRA !== 'number' || screen.latestPRA < 0 || screen.latestPRA > 100)) {
            throw new AppError('BloodAntibodyScreen.latestPRA must be a number between 0 and 100', 400);
        }
        if (screen.testedAt !== undefined && (typeof screen.testedAt !== 'string' || Number.isNaN(Date.parse(screen.testedAt)))) {
            throw new AppError('BloodAntibodyScreen.testedAt must be a valid date', 400);
        }
    }
    return clean;
}

async function createReceiver(payload) {
    const {
        Name, Age, Gender, BloodGroup,
        State, District, ContactNumber, Email,
        Organ_needed, Urgency,
        Hospital: hospitalId,
        IsVerified,
        Status,
        VerifiedBy,
        HLA_Typing,
        cPRA,
        UnacceptableAntigens,
        MELD_score,
        MELD_ExceptionPoints,
        HeartStatus,
        SensitizationEvents,
        AcceptsExtendedCriteria,
        AcceptsPediatricOrgan,
        MinOrganWeight_grams,
        MaxOrganWeight_grams,
        DialysisDuration_months
    } = payload;

    const location = validateLocation(State, District);
    if (!location.ok) {
        throw new AppError(location.message, location.status);
    }

    const status = Status || 'pending';

    // WaitlistDate is a server-side stamp, not a client field: it anchors the
    // waiting-time score (the longer on the list, the higher the score), so it
    // must not be back- or forward-datable through the API. It is stamped ONLY
    // at waitlist entry (Status 'waiting') — a pending/verified receiver has no
    // entry date and therefore a 0 waiting-time factor until they join the
    // list. The model default (null) is the fallback for non-waiting records.
    let waitlistDate = undefined;
    if (status === 'waiting') {
        // Medical-urgency markers are what put a receiver on a real waitlist
        // (heart status tiers 1-6, MELD for liver). Refusing waitlist entry
        // without them keeps urgency-based allocation honest: a heart receiver
        // entered as "waiting" with no HeartStatus would otherwise be
        // invisible to the heart urgency factor and rank by waiting time alone.
        const organKey = String(Organ_needed || '').trim().toLowerCase();
        if (organKey === 'heart' && HeartStatus == null) {
            throw new AppError('HeartStatus (1-6) is required before a heart receiver can enter the waitlist', 400);
        }
        if (organKey === 'liver' && MELD_score == null) {
            throw new AppError('MELD_score (6-40) is required before a liver receiver can enter the waitlist', 400);
        }
        waitlistDate = new Date();
    }

    return Receiver.create({
        Name,
        Age,
        Gender,
        BloodGroup,
        State,
        District,
        ContactNumber,
        Email,
        Organ_needed,
        Urgency,
        Hospital: hospitalId,
        IsVerified: IsVerified === true,
        Status: status,
        VerifiedBy: VerifiedBy || undefined,
        WaitlistDate: waitlistDate,
        HLA_Typing: HLA_Typing || undefined,
        cPRA: cPRA != null ? cPRA : undefined,
        UnacceptableAntigens: UnacceptableAntigens || undefined,
        MELD_score: MELD_score != null ? MELD_score : undefined,
        MELD_ExceptionPoints: MELD_ExceptionPoints != null ? MELD_ExceptionPoints : undefined,
        HeartStatus: HeartStatus != null ? HeartStatus : undefined,
        SensitizationEvents: SensitizationEvents != null ? SensitizationEvents : undefined,
        AcceptsExtendedCriteria: AcceptsExtendedCriteria === true,
        AcceptsPediatricOrgan: AcceptsPediatricOrgan === true,
        MinOrganWeight_grams: MinOrganWeight_grams != null ? MinOrganWeight_grams : undefined,
        MaxOrganWeight_grams: MaxOrganWeight_grams != null ? MaxOrganWeight_grams : undefined,
        DialysisDuration_months: DialysisDuration_months != null ? DialysisDuration_months : undefined
    });
}

async function getMyReceiver(linkedReceiverId) {
    if (!linkedReceiverId) {
        throw new AppError('this account is not linked to a receiver record', 404);
    }

    const receiver = await Receiver.findById(linkedReceiverId).populate('Hospital', 'Name State District');

    if (!receiver) {
        throw new AppError('linked receiver record not found', 404);
    }

    return receiver;
}

// All filters are optional and combine with AND. Returns a list sorted most
// urgent first, then longest-waiting first.
async function listReceivers(query) {
    const { organ, bloodGroup, urgency, state, district, status } = query;
    const filter = {};

    if (organ) filter.Organ_needed = organ;
    if (bloodGroup) filter.BloodGroup = bloodGroup;
    if (urgency) filter.Urgency = urgency;
    if (state) filter.State = state;
    if (district) filter.District = district;
    if (status) filter.Status = status;

    const urgencyOrder = { critical: 0, urgent: 1, stable: 2 };

    const receivers = await Receiver.find(filter)
        .populate('Hospital', 'Name State District')
        .sort({ WaitlistDate: 1 });

    // Sort in memory by urgency — Mongo can't order by an enum's logical
    // position, but the candidate list is small (filtered first).
    receivers.sort((a, b) => urgencyOrder[a.Urgency] - urgencyOrder[b.Urgency]);

    return receivers;
}

async function getReceiverById(id) {
    const receiver = await Receiver.findById(id).populate('Hospital', 'Name State District');
    if (!receiver) {
        throw new AppError('receiver not found', 404);
    }
    return receiver;
}

// Updates a receiver. Only the whitelisted contact/clinical fields are
// accepted; anything else (verification, waitlist state, hospital) is
// rejected with 400. Hospital users can only touch receivers at their own
// hospital, and every successful update writes a RECEIVER_UPDATED audit row.
async function updateReceiver(id, updates, user, req) {
    if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
        throw new AppError('update payload must be an object', 400);
    }

    const requestedKeys = Object.keys(updates);
    const forbidden = requestedKeys.filter((k) => !ALLOWED_RECEIVER_UPDATE_FIELDS.includes(k));
    if (forbidden.length > 0) {
        throw new AppError(`field(s) cannot be updated through this endpoint: ${forbidden.join(', ')}`, 400);
    }
    if (requestedKeys.length === 0) {
        throw new AppError('no updatable fields provided', 400);
    }

    const existing = await Receiver.findById(id);
    if (!existing) {
        throw new AppError('receiver not found', 404);
    }

    // Hospital users may only update receivers at their own hospital.
    if (user && user.Hospital && String(existing.Hospital || '') !== String(user.Hospital)) {
        throw new AppError('receiver belongs to a different hospital', 403);
    }

    const clean = validateReceiverUpdates(existing, updates);

    const previousValues = {};
    for (const key of requestedKeys) {
        previousValues[key] = existing[key];
    }

    const receiver = await Receiver.findByIdAndUpdate(
        id,
        { $set: clean },
        { returnDocument: 'after', runValidators: true }
    );

    if (!receiver) {
        throw new AppError('receiver not found', 404);
    }

    await logAudit({
        event: 'RECEIVER_UPDATED',
        actor: {
            userId: user && (user.id || user._id),
            hospitalId: user && user.Hospital,
            role: user && user.Role
        },
        targetType: 'Receiver',
        targetId: receiver._id,
        req,
        payload: { updatedFields: requestedKeys, previousValues }
    });

    return receiver;
}

module.exports = { createReceiver, getMyReceiver, listReceivers, getReceiverById, updateReceiver };
