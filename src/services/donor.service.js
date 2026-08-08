const AppError = require('../utils/AppError');
const Donor = require('../models/donor.model');
const { validateLocation } = require('../utils/location');
const { logAudit } = require('../utils/auditLogger');

// Fields a coordinator may change through PATCH /api/donor/:id. Verification
// (IsVerified/VerifiedBy), consent (ConsentGiven/ConsentDate), waitlist/organ
// state (Status, OrgansDonated), identity, and hospital assignment are
// deliberately excluded — those only change through dedicated, audited
// workflows. Passing any other field is a 400, not a silent ignore, so a
// client can't assume a change it wasn't authorized to make succeeded.
const ALLOWED_DONOR_UPDATE_FIELDS = [
    'Name', 'ContactNumber', 'Email', 'District', 'MedicalHistory'
];

// Validate the handful of permitted fields before they touch the DB. Returns
// a clean, type-checked object or throws AppError(400).
function validateDonorUpdates(existing, updates) {
    const clean = {};
    for (const key of ALLOWED_DONOR_UPDATE_FIELDS) {
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
    if (clean.MedicalHistory !== undefined) {
        if (typeof clean.MedicalHistory !== 'object' || clean.MedicalHistory === null || Array.isArray(clean.MedicalHistory)) {
            throw new AppError('MedicalHistory must be an object', 400);
        }
        if (clean.MedicalHistory.MalignancyFreeYears != null &&
            (typeof clean.MedicalHistory.MalignancyFreeYears !== 'number' || clean.MedicalHistory.MalignancyFreeYears < 0)) {
            throw new AppError('MalignancyFreeYears cannot be negative', 400);
        }
    }
    return clean;
}

async function createDonor(payload) {
    const {
        Name, Age, Gender, BloodGroup, DonorType,
        State, District, ContactNumber, Email,
        Organs,
        Hospital: hospitalId,
        ConsentGiven,
        IsVerified,
        Status,
        VerifiedBy,
        MedicalHistory
    } = payload;

    const location = validateLocation(State, District);
    if (!location.ok) {
        throw new AppError(location.message, location.status);
    }

    if (!Array.isArray(Organs) || Organs.length === 0) {
        throw new AppError('at least one organ is required', 400);
    }

    return Donor.create({
        Name,
        Age,
        Gender,
        BloodGroup,
        DonorType,
        State,
        District,
        ContactNumber,
        Email,
        OrgansDonated: Organs.map((organ) => ({ Organ: organ, Status: 'available' })),
        Hospital: hospitalId,
        ConsentGiven: ConsentGiven !== undefined ? ConsentGiven : false,
        ConsentDate: ConsentGiven ? new Date() : undefined,
        IsVerified: IsVerified === true,
        Status: Status || 'pending',
        VerifiedBy: VerifiedBy || undefined,
        MedicalHistory: MedicalHistory || undefined
    });
}

// Fetches the donor record that the authenticated user account is linked to.
// Throws 404 if either the linkage is missing or the donor has been deleted.
async function getMyDonor(linkedDonorId) {
    if (!linkedDonorId) {
        throw new AppError('this account is not linked to a donor record', 404);
    }

    const donor = await Donor.findById(linkedDonorId).populate('Hospital', 'Name State District');

    if (!donor) {
        throw new AppError('linked donor record not found', 404);
    }

    return donor;
}

// All filters are optional and combine with AND.
function buildDonorFilter({ organ, bloodGroup, state, district, status }) {
    const filter = {};
    if (organ) filter['OrgansDonated.Organ'] = organ;
    if (bloodGroup) filter.BloodGroup = bloodGroup;
    if (state) filter.State = state;
    if (district) filter.District = district;
    if (status) filter.Status = status;
    return filter;
}

async function listDonors(query) {
    const filter = buildDonorFilter(query);
    return Donor.find(filter).populate('Hospital', 'Name State District');
}

async function getDonorById(id) {
    const donor = await Donor.findById(id).populate('Hospital', 'Name State District');
    if (!donor) {
        throw new AppError('donor not found', 404);
    }
    return donor;
}

// Updates a donor. Only the whitelisted contact/clinical-history fields are
// accepted; anything else (verification, consent, status, organs) is rejected
// with 400. Hospital users can only touch donors at their own hospital, and
// every successful update writes a DONOR_UPDATED audit row.
async function updateDonor(id, updates, user, req) {
    if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
        throw new AppError('update payload must be an object', 400);
    }

    const requestedKeys = Object.keys(updates);
    const forbidden = requestedKeys.filter((k) => !ALLOWED_DONOR_UPDATE_FIELDS.includes(k));
    if (forbidden.length > 0) {
        throw new AppError(`field(s) cannot be updated through this endpoint: ${forbidden.join(', ')}`, 400);
    }
    if (requestedKeys.length === 0) {
        throw new AppError('no updatable fields provided', 400);
    }

    const existing = await Donor.findById(id);
    if (!existing) {
        throw new AppError('donor not found', 404);
    }

    // Hospital users may only update donors at their own hospital.
    if (user && user.Hospital && String(existing.Hospital || '') !== String(user.Hospital)) {
        throw new AppError('donor belongs to a different hospital', 403);
    }

    const clean = validateDonorUpdates(existing, updates);

    const previousValues = {};
    for (const key of requestedKeys) {
        previousValues[key] = existing[key];
    }

    const donor = await Donor.findByIdAndUpdate(
        id,
        { $set: clean },
        { returnDocument: 'after', runValidators: true }
    );

    if (!donor) {
        throw new AppError('donor not found', 404);
    }

    await logAudit({
        event: 'DONOR_UPDATED',
        actor: {
            userId: user && (user.id || user._id),
            hospitalId: user && user.Hospital,
            role: user && user.Role
        },
        targetType: 'Donor',
        targetId: donor._id,
        req,
        payload: { updatedFields: requestedKeys, previousValues }
    });

    return donor;
}

module.exports = { createDonor, getMyDonor, listDonors, getDonorById, updateDonor };
