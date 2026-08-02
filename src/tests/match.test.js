const request = require('supertest');
const app = require('../app');
const { connectTestDB, closeTestDB, clearTestDB } = require('./setup');
const { createAdminAndToken, createHospital, createDonor, createReceiver } = require('./helpers');

describe('Match routes', () => {

    beforeAll(async () => {
        await connectTestDB();
    });

    afterEach(async () => {
        await clearTestDB();
    });

    afterAll(async () => {
        await closeTestDB();
    });

    describe('GET /api/match/suggest/:receiverId', () => {
        it('excludes donors with an incompatible blood type', async () => {
            const adminToken = await createAdminAndToken();
            const hospital = await createHospital(adminToken);

            // A+ cannot donate to an O+ receiver under real ABO compatibility rules.
            await createDonor(hospital._id, { BloodGroup: 'A+', ContactNumber: '111' });
            const receiver = await createReceiver(hospital._id, { BloodGroup: 'O+' });

            const response = await request(app)
                .get(`/api/match/suggest/${receiver._id}`)
                .set('Authorization', `Bearer ${adminToken}`);

            expect(response.status).toBe(200);
            expect(response.body.count).toBe(0);
        });

        it('includes compatible donors and ranks same-district ones first', async () => {
            const adminToken = await createAdminAndToken();
            const hospital = await createHospital(adminToken);

            // O- is a universal donor — compatible with an O+ receiver.
            await createDonor(hospital._id, {
                Name: 'SameDistrict Donor', BloodGroup: 'O-', District: 'Chennai', ContactNumber: '111'
            });
            await createDonor(hospital._id, {
                Name: 'OtherDistrict Donor', BloodGroup: 'O-', District: 'Coimbatore', ContactNumber: '222'
            });

            const receiver = await createReceiver(hospital._id, { BloodGroup: 'O+', District: 'Chennai' });

            const response = await request(app)
                .get(`/api/match/suggest/${receiver._id}`)
                .set('Authorization', `Bearer ${adminToken}`);

            expect(response.status).toBe(200);
            expect(response.body.count).toBe(2);
            // The same-district donor should be ranked first.
            expect(response.body.candidates[0].Name).toBe('SameDistrict Donor');
            expect(response.body.candidates[0].matchQuality).toBe('same district');
        });

        it('requires admin/hospital role, not any logged-in user', async () => {
            const adminToken = await createAdminAndToken();
            const hospital = await createHospital(adminToken);
            const receiver = await createReceiver(hospital._id);

            const donorAccount = await request(app)
                .post('/api/auth/register')
                .send({ Name: 'Random Donor', Email: 'random@test.com', Password: 'password123', Role: 'donor' });

            const response = await request(app)
                .get(`/api/match/suggest/${receiver._id}`)
                .set('Authorization', `Bearer ${donorAccount.body.token}`);

            expect(response.status).toBe(403);
        });
    });

    describe('POST /api/match', () => {
        it('creates a match and flips donor organ + receiver status', async () => {
            const adminToken = await createAdminAndToken();
            const hospital = await createHospital(adminToken);
            const donor = await createDonor(hospital._id);
            const receiver = await createReceiver(hospital._id);

            const matchResponse = await request(app)
                .post('/api/match')
                .set('Authorization', `Bearer ${adminToken}`)
                .send({
                    Donor: donor._id,
                    Receiver: receiver._id,
                    Organ: 'Kidney',
                    Hospital: hospital._id
                });

            expect(matchResponse.status).toBe(201);

            // Confirm the donor's organ status actually flipped.
            const donorCheck = await request(app)
                .get(`/api/donor/${donor._id}`)
                .set('Authorization', `Bearer ${adminToken}`);
            expect(donorCheck.body.donor.OrgansDonated[0].Status).toBe('matched');

            // Confirm the receiver's status actually flipped.
            const receiverCheck = await request(app)
                .get(`/api/receiver/${receiver._id}`)
                .set('Authorization', `Bearer ${adminToken}`);
            expect(receiverCheck.body.receiver.Status).toBe('matched');
        });

        it('blocks matching the same organ twice', async () => {
            const adminToken = await createAdminAndToken();
            const hospital = await createHospital(adminToken);
            const donor = await createDonor(hospital._id);
            const receiver = await createReceiver(hospital._id);

            await request(app)
                .post('/api/match')
                .set('Authorization', `Bearer ${adminToken}`)
                .send({ Donor: donor._id, Receiver: receiver._id, Organ: 'Kidney', Hospital: hospital._id });

            // Try to match the same donor's Kidney again with a different receiver.
            const secondReceiver = await createReceiver(hospital._id, { ContactNumber: '999' });
            const response = await request(app)
                .post('/api/match')
                .set('Authorization', `Bearer ${adminToken}`)
                .send({ Donor: donor._id, Receiver: secondReceiver._id, Organ: 'Kidney', Hospital: hospital._id });

            expect(response.status).toBe(409);
        });

        it('blocks matching an organ the donor never offered', async () => {
            const adminToken = await createAdminAndToken();
            const hospital = await createHospital(adminToken);
            const donor = await createDonor(hospital._id); // only offered Kidney
            const receiver = await createReceiver(hospital._id);

            const response = await request(app)
                .post('/api/match')
                .set('Authorization', `Bearer ${adminToken}`)
                .send({ Donor: donor._id, Receiver: receiver._id, Organ: 'Liver', Hospital: hospital._id });

            expect(response.status).toBe(400);
        });
    });
});