const request = require('supertest');
const app = require('../app');
const AuditLog = require('../models/auditLog.model');
const { connectTestDB, closeTestDB, clearTestDB } = require('./setup');
const { createAdminAndToken, createHospital, createDonor, createHospitalUser } = require('./helpers');

// `describe` groups related tests together — think of it as a folder/heading.
// `beforeAll` runs once before any test in this file. `afterEach` runs after
// EVERY test (to reset the database). `afterAll` runs once at the very end.
describe('Donor routes', () => {

    beforeAll(async () => {
        await connectTestDB();
    });

    afterEach(async () => {
        await clearTestDB();
    });

    afterAll(async () => {
        await closeTestDB();
    });

    // --- Test 1: creating a donor with missing fields should fail ---
    it('rejects donor creation when required fields are missing', async () => {
        // supertest lets us call your Express app directly, no real server needed.
        const response = await request(app)
            .post('/api/donor')
            .send({ Name: 'Ravi' }); // deliberately incomplete

        // `expect` is how we check the result. If this fails, Jest tells you
        // exactly what it expected vs what it actually got.
        expect(response.status).toBe(400);
        expect(response.body).toHaveProperty('message');
    });

    // --- Test 2: creating a donor with valid data should succeed ---
    it('creates a donor when all required fields are valid', async () => {
        const response = await request(app)
            .post('/api/donor')
            .send({
                Name: 'Ravi Kumar',
                Age: 30,
                Gender: 'male',
                BloodGroup: 'O+',
                DonorType: 'living',
                State: 'Tamil Nadu',
                District: 'Chennai',
                ContactNumber: '9123456780',
                Organs: ['Kidney'],
                ConsentGiven: true
            });

        expect(response.status).toBe(201);
        expect(response.body.donor).toHaveProperty('_id');
        expect(response.body.donor.OrgansDonated[0].Organ).toBe('Kidney');
        expect(response.body.donor.OrgansDonated[0].Status).toBe('available');
    });

    // --- Test 3: an invalid state/district should be rejected ---
    it('rejects a donor with a state/district that does not exist', async () => {
        const response = await request(app)
            .post('/api/donor')
            .send({
                Name: 'Ravi Kumar',
                Age: 30,
                Gender: 'male',
                BloodGroup: 'O+',
                DonorType: 'living',
                State: 'Tamil Nadu',
                District: 'Mumbai', // Mumbai is not a Tamil Nadu district
                ContactNumber: '9123456780',
                Organs: ['Kidney'],
                ConsentGiven: true
            });

        expect(response.status).toBe(404);
    });

    // --- Test 4: the donor list route requires authentication ---
    it('blocks GET /api/donor without a login token', async () => {
        const response = await request(app).get('/api/donor');

        expect(response.status).toBe(401);
    });

    // --- Test 5: an admin CAN see the donor list ---
    it('allows GET /api/donor for a logged-in admin', async () => {
        // Admin accounts are no longer reachable through the public
        // register endpoint — bootstrap via the test helper instead.
        const token = await createAdminAndToken();

        const response = await request(app)
            .get('/api/donor')
            .set('Authorization', `Bearer ${token}`);

        expect(response.status).toBe(200);
        expect(response.body).toHaveProperty('donors');
    });

    // --- Test 6: PATCH /api/donor/:id — whitelist + audit --------------------
    it('allows an admin to update whitelisted donor fields and audits it', async () => {
        const adminToken = await createAdminAndToken();
        const hospital = await createHospital(adminToken);
        const donor = await createDonor(hospital._id);

        const response = await request(app)
            .patch(`/api/donor/${donor._id}`)
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ ContactNumber: '9123456789' });

        expect(response.status).toBe(200);
        expect(response.body.donor.ContactNumber).toBe('9123456789');

        const audits = await AuditLog.find({ Event: 'DONOR_UPDATED' }).lean();
        expect(audits).toHaveLength(1);
        expect(audits[0].TargetType).toBe('Donor');
        expect(audits[0].Payload.updatedFields).toEqual(['ContactNumber']);
    });

    it('rejects updating verification, consent, status, or organ state through PATCH', async () => {
        const adminToken = await createAdminAndToken();
        const hospital = await createHospital(adminToken);
        const donor = await createDonor(hospital._id);

        const response = await request(app)
            .patch(`/api/donor/${donor._id}`)
            .set('Authorization', `Bearer ${adminToken}`)
            .send({
                IsVerified: false,
                ConsentGiven: false,
                Status: 'rejected',
                OrgansDonated: [{ Organ: 'Kidney', Status: 'unavailable' }]
            });

        expect(response.status).toBe(400);
        expect(response.body.message).toMatch(/cannot be updated/i);

        // None of the protected fields actually changed.
        const check = await request(app)
            .get(`/api/donor/${donor._id}`)
            .set('Authorization', `Bearer ${adminToken}`);
        expect(check.body.donor.IsVerified).toBe(true);
        expect(check.body.donor.ConsentGiven).toBe(true);
        expect(check.body.donor.Status).toBe('available');
    });

    it('blocks a hospital user from updating a donor at another hospital', async () => {
        const adminToken = await createAdminAndToken();
        const hospitalA = await createHospital(adminToken);
        const hospitalB = await createHospital(adminToken);
        const hospitalAToken = await createHospitalUser(hospitalA._id);

        const donor = await createDonor(hospitalB._id);

        const response = await request(app)
            .patch(`/api/donor/${donor._id}`)
            .set('Authorization', `Bearer ${hospitalAToken}`)
            .send({ ContactNumber: '9000000000' });

        expect(response.status).toBe(403);
    });
});