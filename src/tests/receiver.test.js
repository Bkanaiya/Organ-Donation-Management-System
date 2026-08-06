const request = require('supertest');
const app = require('../app');
const { connectTestDB, closeTestDB, clearTestDB } = require('./setup');
const { createAdminAndToken, createHospital, createReceiver } = require('./helpers');

describe('Receiver routes', () => {

    beforeAll(async () => {
        await connectTestDB();
    });

    afterEach(async () => {
        await clearTestDB();
    });

    afterAll(async () => {
        await closeTestDB();
    });

    it('rejects receiver creation when required fields are missing', async () => {
        const response = await request(app)
            .post('/api/receiver')
            .send({ Name: 'Suresh' });

        expect(response.status).toBe(400);
    });

    it('creates a receiver when all required fields are valid', async () => {
        const adminToken = await createAdminAndToken();
        const hospital = await createHospital(adminToken);

        const response = await request(app)
            .post('/api/receiver')
            .send({
                Name: 'Suresh Babu',
                Age: 40,
                Gender: 'male',
                BloodGroup: 'O+',
                State: 'Tamil Nadu',
                District: 'Chennai',
                ContactNumber: '9988776655',
                Organ_needed: 'Kidney',
                Urgency: 'critical',
                Hospital: hospital._id
            });

        expect(response.status).toBe(201);
        expect(response.body.receiver.Urgency).toBe('critical');
        // Status should default to "pending" until an admin/hospital verifies it.
        expect(response.body.receiver.Status).toBe('pending');
    });

    it('filters the receiver list by urgency', async () => {
        const adminToken = await createAdminAndToken();
        const hospital = await createHospital(adminToken);

        await createReceiver(hospital._id, { Urgency: 'critical', ContactNumber: '111' });
        await createReceiver(hospital._id, { Urgency: 'stable', ContactNumber: '222' });

        const response = await request(app)
            .get('/api/receiver?urgency=critical')
            .set('Authorization', `Bearer ${adminToken}`);

        expect(response.status).toBe(200);
        expect(response.body.count).toBe(1);
        expect(response.body.receivers[0].Urgency).toBe('critical');
    });

    it('blocks PATCH /api/receiver/:id without admin/hospital role', async () => {
        const adminToken = await createAdminAndToken();
        const hospital = await createHospital(adminToken);
        const receiver = await createReceiver(hospital._id);

        // Register a plain donor-role account — should NOT be allowed to patch a receiver.
        const donorAccount = await request(app)
            .post('/api/auth/register')
            .send({ Name: 'Some Donor', Email: 'donor-role@test.com', Password: 'password123' });

        const response = await request(app)
            .patch(`/api/receiver/${receiver._id}`)
            .set('Authorization', `Bearer ${donorAccount.body.token}`)
            .send({ Status: 'matched' });

        expect(response.status).toBe(403);
    });

    it('allows an admin to update a receiver Status via PATCH', async () => {
        const adminToken = await createAdminAndToken();
        const hospital = await createHospital(adminToken);
        const receiver = await createReceiver(hospital._id);

        const response = await request(app)
            .patch(`/api/receiver/${receiver._id}`)
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ Status: 'matched' });

        expect(response.status).toBe(200);
        expect(response.body.receiver.Status).toBe('matched');
    });
});