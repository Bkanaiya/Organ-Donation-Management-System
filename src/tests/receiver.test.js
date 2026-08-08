const request = require('supertest');
const app = require('../app');
const AuditLog = require('../models/auditLog.model');
const { connectTestDB, closeTestDB, clearTestDB } = require('./setup');
const { createAdminAndToken, createHospital, createReceiver, createHospitalUser } = require('./helpers');

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

    it('allows an admin to update whitelisted receiver fields via PATCH', async () => {
        const adminToken = await createAdminAndToken();
        const hospital = await createHospital(adminToken);
        const receiver = await createReceiver(hospital._id);

        const response = await request(app)
            .patch(`/api/receiver/${receiver._id}`)
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ Urgency: 'stable' });

        expect(response.status).toBe(200);
        expect(response.body.receiver.Urgency).toBe('stable');
    });

    it('rejects updating waitlist or verification state through PATCH', async () => {
        const adminToken = await createAdminAndToken();
        const hospital = await createHospital(adminToken);
        const receiver = await createReceiver(hospital._id);

        const response = await request(app)
            .patch(`/api/receiver/${receiver._id}`)
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ Status: 'matched', IsVerified: false });

        expect(response.status).toBe(400);
        expect(response.body.message).toMatch(/cannot be updated/i);

        // None of the protected fields actually changed.
        const check = await request(app)
            .get(`/api/receiver/${receiver._id}`)
            .set('Authorization', `Bearer ${adminToken}`);
        expect(check.body.receiver.Status).toBe('waiting');
        expect(check.body.receiver.IsVerified).toBe(true);
    });

    it('writes a RECEIVER_UPDATED audit row on a successful update', async () => {
        const adminToken = await createAdminAndToken();
        const hospital = await createHospital(adminToken);
        const receiver = await createReceiver(hospital._id);

        await request(app)
            .patch(`/api/receiver/${receiver._id}`)
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ Urgency: 'stable' });

        const audits = await AuditLog.find({ Event: 'RECEIVER_UPDATED' }).lean();
        expect(audits).toHaveLength(1);
        expect(audits[0].TargetType).toBe('Receiver');
        expect(audits[0].Payload.updatedFields).toEqual(['Urgency']);
    });

    it('blocks a hospital user from updating a receiver at another hospital', async () => {
        const adminToken = await createAdminAndToken();
        const hospitalA = await createHospital(adminToken);
        const hospitalB = await createHospital(adminToken);
        const hospitalAToken = await createHospitalUser(hospitalA._id);

        const receiver = await createReceiver(hospitalB._id);

        const response = await request(app)
            .patch(`/api/receiver/${receiver._id}`)
            .set('Authorization', `Bearer ${hospitalAToken}`)
            .send({ Urgency: 'stable' });

        expect(response.status).toBe(403);
    });

    it('accepts HeartStatus and MELD_ExceptionPoints at creation and via PATCH', async () => {
        const adminToken = await createAdminAndToken();
        const hospital = await createHospital(adminToken);

        const create = await request(app)
            .post('/api/receiver')
            .send({
                Name: 'Suresh Babu',
                Age: 40,
                Gender: 'male',
                BloodGroup: 'O+',
                State: 'Tamil Nadu',
                District: 'Chennai',
                ContactNumber: '9988776655',
                Organ_needed: 'Heart',
                Urgency: 'stable',
                Hospital: hospital._id,
                HeartStatus: 2,
                MELD_ExceptionPoints: 8
            });
        expect(create.status).toBe(201);
        expect(create.body.receiver.HeartStatus).toBe(2);
        expect(create.body.receiver.MELD_ExceptionPoints).toBe(8);

        const patch = await request(app)
            .patch(`/api/receiver/${create.body.receiver._id}`)
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ HeartStatus: 1, MELD_ExceptionPoints: 12 });
        expect(patch.status).toBe(200);
        expect(patch.body.receiver.HeartStatus).toBe(1);
        expect(patch.body.receiver.MELD_ExceptionPoints).toBe(12);
    });

    it('rejects out-of-range HeartStatus and MELD_ExceptionPoints', async () => {
        const adminToken = await createAdminAndToken();
        const hospital = await createHospital(adminToken);
        const receiver = await createReceiver(hospital._id);

        const badHeart = await request(app)
            .patch(`/api/receiver/${receiver._id}`)
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ HeartStatus: 7 });
        expect(badHeart.status).toBe(400);

        const badMeld = await request(app)
            .patch(`/api/receiver/${receiver._id}`)
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ MELD_ExceptionPoints: -1 });
        expect(badMeld.status).toBe(400);
    });

    it('stamps WaitlistDate server-side only at waitlist entry, ignoring a client-supplied value', async () => {
        const adminToken = await createAdminAndToken();
        const hospital = await createHospital(adminToken);
        const backdated = '2020-01-01T00:00:00.000Z';

        // A pending receiver (no Status) has NOT joined the waitlist yet, so
        // they must have no WaitlistDate — their waiting-time factor is 0
        // until they actually enter the list.
        const pending = await request(app)
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
                Urgency: 'stable',
                Hospital: hospital._id,
                WaitlistDate: backdated
            });
        expect(pending.status).toBe(201);
        expect(pending.body.receiver.Status).toBe('pending');
        expect(pending.body.receiver.WaitlistDate).toBeNull();

        // Entering the waitlist (Status 'waiting') stamps the entry date
        // server-side — never the client-supplied value, which could be
        // backdated to inflate the waiting-time score.
        const waiting = await request(app)
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
                Urgency: 'stable',
                Hospital: hospital._id,
                Status: 'waiting',
                WaitlistDate: backdated
            });
        expect(waiting.status).toBe(201);
        expect(waiting.body.receiver.Status).toBe('waiting');
        expect(new Date(waiting.body.receiver.WaitlistDate).toISOString()).not.toBe(backdated);
        expect(Date.now() - new Date(waiting.body.receiver.WaitlistDate).getTime()).toBeLessThan(60_000);
    });

    it('requires HeartStatus (heart) / MELD_score (liver) before a receiver can enter the waitlist', async () => {
        const adminToken = await createAdminAndToken();
        const hospital = await createHospital(adminToken);
        const base = {
            Name: 'Suresh Babu',
            Age: 40,
            Gender: 'male',
            BloodGroup: 'O+',
            State: 'Tamil Nadu',
            District: 'Chennai',
            ContactNumber: '9988776655',
            Hospital: hospital._id,
            Status: 'waiting'
        };

        const heart = await request(app)
            .post('/api/receiver')
            .send({ ...base, Organ_needed: 'Heart', Urgency: 'critical' });
        expect(heart.status).toBe(400);
        expect(heart.body.message).toMatch(/HeartStatus/i);

        const liver = await request(app)
            .post('/api/receiver')
            .send({ ...base, Organ_needed: 'Liver', Urgency: 'critical' });
        expect(liver.status).toBe(400);
        expect(liver.body.message).toMatch(/MELD_score/i);

        // A heart receiver may still be registered as pending without the tier.
        const pendingHeart = await request(app)
            .post('/api/receiver')
            .send({ ...base, Organ_needed: 'Heart', Urgency: 'critical', Status: 'pending' });
        expect(pendingHeart.status).toBe(201);
        expect(pendingHeart.body.receiver.Status).toBe('pending');

        // Once the marker is present, waitlist entry succeeds and the entry
        // date is stamped.
        const okHeart = await request(app)
            .post('/api/receiver')
            .send({ ...base, Organ_needed: 'Heart', Urgency: 'critical', HeartStatus: 3 });
        expect(okHeart.status).toBe(201);
        expect(okHeart.body.receiver.HeartStatus).toBe(3);
        expect(okHeart.body.receiver.WaitlistDate).not.toBeNull();
    });
});