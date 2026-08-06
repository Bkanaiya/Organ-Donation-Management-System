const AppError = require('../utils/AppError');
const Donor = require('../models/donor.model');
const { validateLocation } = require('../utils/location');

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

async function updateDonor(id, updates) {
    const donor = await Donor.findByIdAndUpdate(
        id,
        updates,
        { new: true, runValidators: true }
    );

    if (!donor) {
        throw new AppError('donor not found', 404);
    }

    return donor;
}

module.exports = { createDonor, getMyDonor, listDonors, getDonorById, updateDonor };
