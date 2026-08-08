const request = require('supertest');
const app = require('../app');
const User = require('../models/user.model');
const Donor = require('../models/donor.model');
const Receiver = require('../models/receiver.model');
const { hashPassword, generateToken } = require('../utils/auth');

// Privileged bootstrap: writes an admin User directly to the test DB.
// The public /api/auth/register endpoint is intentionally locked down so
// callers can't self-register as admin or hospital — tests that need an
// admin/hospital token have to use these helpers (or a real seed script
// in production) instead.
async function createAdminAndToken() {
    const email = `admin-${Date.now()}-${Math.random()}@test.com`;
    const user = await User.create({
        Name: 'Admin',
        Email: email,
        Password: await hashPassword('password123'),
        Role: 'admin'
    });
    return generateToken(user);
}

async function createHospital(adminToken) {
    const response = await request(app)
        .post('/api/hospital')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
            Name: 'Apollo Hospital',
            RegistrationNumber: `REG-${Date.now()}-${Math.random()}`,
            State: 'Tamil Nadu',
            District: 'Chennai',
            ContactNumber: '9876543210'
        });
    return response.body.hospital;
}

// Creates a donor via the public POST /api/donor endpoint. Defaults model
// the eligibility engine's strict-mode happy path:
//   - IsVerified: true (so it survives the eligibility filter)
//   - ConsentGiven: true
//   - Status: 'available'
//   - OrgansDonated[0].Status: 'available'
// Tests that exercise the failure modes pass overrides like
//   { IsVerified: false } or { ConsentGiven: false } to flip the donor out
// of the eligibility set.
//
// The defaults also include the clinical screening data the kidney policy
// demands (HLA typing, infection screen, crossmatch result, cPRA, weight).
// Without these, the eligibility engine correctly rejects the donor as
// un-screened — which is the realistic posture. Tests for unscreened donors
// override these fields to be missing.
async function createDonor(hospitalId, overrides = {}) {
    // When the test doesn't ask for a specific organ we default to Kidney,
    // which is the most-screened policy. Include the screening fields so the
    // public-API path also produces a matchable donor the same way as the
    // direct-insert helper.
    const organ = (overrides.Organs && overrides.Organs[0]) || 'Kidney';
    const screenedKidney = organ === 'Kidney' ? {
        HLA_Typing: { A: ['A1', 'A2'], B: ['B7', 'B8'], DR: ['DR1', 'DR4'] },
        OrganWeight_grams: 180
    } : {};
    const payload = {
        Name: 'Ravi Kumar',
        Age: 30,
        Gender: 'male',
        BloodGroup: 'O+',
        DonorType: 'living',
        State: 'Tamil Nadu',
        District: 'Chennai',
        ContactNumber: '9123456780',
        Organs: [organ],
        Hospital: hospitalId,
        ConsentGiven: true,
        IsVerified: true,
        Status: 'available',
        ...overrides
    };
    const response = await request(app).post('/api/donor').send(payload);
    const { donor } = response.body;

    // The public POST /api/donor doesn't yet persist HLA / weight / infection
    // screen (those land via the future screening UI), so patch them directly
    // on the returned document. This keeps the helpers' contract simple while
    // still producing a fully-screened donor for the happy-path tests.
    if (Object.keys(screenedKidney).length > 0 && donor && donor.OrgansDonated) {
        await Donor.updateOne(
            { _id: donor._id },
            { $set: {
                'OrgansDonated.$[elem].HLA_Typing': screenedKidney.HLA_Typing,
                'OrgansDonated.$[elem].OrganWeight_grams': screenedKidney.OrganWeight_grams,
                'OrgansDonated.$[elem].InfectionScreening': {
                    HIV: false, HepB: false, HepC: false, CMV: false, EBV: false, Syphilis: false
                }
            }},
            { arrayFilters: [{ 'elem.Organ': organ }] }
        );
        // Re-fetch so the caller sees the populated clinical fields.
        
        return await Donor.findById(donor._id);
    }
    return donor;
}

// Directly inserts a donor with one organ having specific clinical fields.
// Used by tests that need to set fields the public create endpoint doesn't
// expose (HLA, OrganQuality, IschemiaStartedAt, etc.).
//
// Defaults include a fully-screened kidney so happy-path tests don't need
// to repeat the clinical fields. Pass `screened: false` (or override
// individual fields with `null`) to seed an un-screened donor. The default
// OrganWeight_grams is organ-appropriate (weight-sensitive organs only) so
// the fail-closed size gate has a plausible weight to compare against.
const DONOR_ORGAN_WEIGHTS = {
    Kidney: 180,
    Liver: 1500,
    Heart: 300,
    Lungs: 450,
    Pancreas: 100,
    'Small Intestine': 1500
};

async function createDonorWithOrgan(hospitalId, { organ = 'Kidney', organFields = {}, donorFields = {}, screened = true } = {}) {
    const screenedFields = screened ? {
        HLA_Typing: { A: ['A1', 'A2'], B: ['B7', 'B8'], DR: ['DR1', 'DR4'] },
        OrganWeight_grams: DONOR_ORGAN_WEIGHTS[organ],
        OrganQuality: 'ideal',
        InfectionScreening: { HIV: false, HepB: false, HepC: false, CMV: false, EBV: false, Syphilis: false }
    } : {};
    return Donor.create({
        Name: 'Ravi Kumar',
        Age: 30,
        Gender: 'male',
        BloodGroup: 'O+',
        DonorType: 'living',
        State: 'Tamil Nadu',
        District: 'Chennai',
        ContactNumber: '9123456780',
        Hospital: hospitalId,
        ConsentGiven: true,
        IsVerified: true,
        Status: 'available',
        OrgansDonated: [{ Organ: organ, Status: 'available', ...screenedFields, ...organFields }],
        ...donorFields
    });
}

// Same defaults as createDonor for the eligibility filter — verified +
// 'waiting' so the receiver is a candidate. Tests that exercise the failure
// modes pass overrides like { Status: 'pending' } or { IsVerified: false }.
//
// The defaults also include the kidney-policy screening fields (HLA typing,
// cPRA) so the eligibility engine doesn't reject the receiver as
// un-screened. Override individual fields (e.g. `{ HLA_Typing: undefined }`)
// when testing the unscreened path.
//
// Weight-sensitive policies fail closed when the receiver has no recorded
// size range (see passesWeightMatch), so the helper records a plausible
// Min/MaxOrganWeight_grams band for the receiver's organ by default. Tests
// that exercise the fail-closed path override both to `undefined`.
const RECEIVER_SIZE_RANGES = {
    Kidney: { min: 100, max: 300 },
    Liver: { min: 1000, max: 2000 },
    Heart: { min: 200, max: 400 },
    Lungs: { min: 300, max: 600 },
    Pancreas: { min: 60, max: 150 },
    'Small Intestine': { min: 1000, max: 2000 }
};

async function createReceiver(hospitalId, overrides = {}) {
    const organ = overrides.Organ_needed || 'Kidney';
    const sizeRange = RECEIVER_SIZE_RANGES[organ];
    // Waitlist entry now requires the medical-urgency marker for the organ
    // (HeartStatus for hearts, MELD_score for livers — see receiver.service.js
    // createReceiver). The helper defaults them so waiting receivers are
    // created successfully; pass the field explicitly (even as `undefined`)
    // to exercise the missing-marker paths.
    const urgencyDefaults = {};
    if (organ === 'Liver' && !('MELD_score' in overrides)) urgencyDefaults.MELD_score = 25;
    if (organ === 'Heart' && !('HeartStatus' in overrides)) urgencyDefaults.HeartStatus = 3;
    const payload = {
        Name: 'Suresh Babu',
        Age: 40,
        Gender: 'male',
        BloodGroup: 'O+',
        State: 'Tamil Nadu',
        District: 'Chennai',
        ContactNumber: '9988776655',
        Organ_needed: organ,
        Urgency: 'critical',
        Hospital: hospitalId,
        IsVerified: true,
        Status: 'waiting',
        HLA_Typing: { A: ['A1', 'A2'], B: ['B7', 'B8'], DR: ['DR1', 'DR4'] },
        cPRA: 5,
        MinOrganWeight_grams: sizeRange ? sizeRange.min : undefined,
        MaxOrganWeight_grams: sizeRange ? sizeRange.max : undefined,
        ...urgencyDefaults,
        ...overrides
    };
    const response = await request(app).post('/api/receiver').send(payload);
    return response.body.receiver;
}

// Writes a hospital-role User linked to a specific Hospital record and
// returns a JWT. Used to exercise cross-hospital authorization tests.
async function createHospitalUser(hospitalId) {
    const email = `hospital-${Date.now()}-${Math.random()}@test.com`;
    const user = await User.create({
        Name: 'Hospital User',
        Email: email,
        Password: await hashPassword('password123'),
        Role: 'hospital',
        Hospital: hospitalId
    });
    return generateToken(user);
}

module.exports = {
    createAdminAndToken,
    createHospital,
    createDonor,
    createDonorWithOrgan,
    createReceiver,
    createHospitalUser
};