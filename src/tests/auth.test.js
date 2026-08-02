const request = require('supertest');
const app = require('../app');
const { connectTestDB, closeTestDB, clearTestDB } = require('./setup');

describe('Auth routes', () => {

    beforeAll(async () => {
        await connectTestDB();
    });

    afterEach(async () => {
        await clearTestDB();
    });

    afterAll(async () => {
        await closeTestDB();
    });

    // --- Registration ---
    it('registers a new account and returns a token', async () => {
        const response = await request(app)
            .post('/api/auth/register')
            .send({
                Name: 'Admin User',
                Email: 'admin@test.com',
                Password: 'password123',
                Role: 'admin'
            });

        expect(response.status).toBe(201);
        expect(response.body).toHaveProperty('token');
        expect(response.body.user.Email).toBe('admin@test.com');
        // The password hash should never come back in the response.
        expect(response.body.user).not.toHaveProperty('Password');
    });

    it('rejects registration with a missing required field', async () => {
        const response = await request(app)
            .post('/api/auth/register')
            .send({ Email: 'noname@test.com', Password: 'password123' }); // no Name

        expect(response.status).toBe(400);
    });

    it('rejects registration with an email that is already used', async () => {
        // Register once...
        await request(app)
            .post('/api/auth/register')
            .send({ Name: 'First', Email: 'dupe@test.com', Password: 'password123', Role: 'admin' });

        // ...then try to register the same email again.
        const response = await request(app)
            .post('/api/auth/register')
            .send({ Name: 'Second', Email: 'dupe@test.com', Password: 'password123', Role: 'admin' });

        expect(response.status).toBe(409);
    });

    // --- Login ---
    it('logs in with correct credentials', async () => {
        await request(app)
            .post('/api/auth/register')
            .send({ Name: 'Admin', Email: 'login@test.com', Password: 'password123', Role: 'admin' });

        const response = await request(app)
            .post('/api/auth/login')
            .send({ Email: 'login@test.com', Password: 'password123' });

        expect(response.status).toBe(200);
        expect(response.body).toHaveProperty('token');
    });

    it('rejects login with the wrong password', async () => {
        await request(app)
            .post('/api/auth/register')
            .send({ Name: 'Admin', Email: 'wrongpass@test.com', Password: 'password123', Role: 'admin' });

        const response = await request(app)
            .post('/api/auth/login')
            .send({ Email: 'wrongpass@test.com', Password: 'not-the-right-password' });

        expect(response.status).toBe(401);
    });

    it('rejects login for an email that was never registered', async () => {
        const response = await request(app)
            .post('/api/auth/login')
            .send({ Email: 'ghost@test.com', Password: 'whatever123' });

        expect(response.status).toBe(401);
    });

    // --- Linking a donor/receiver account to their own record ---
    it('links a donor account to their record only when the email matches', async () => {
        // Create a donor record directly (public route, no auth needed).
        const donorResponse = await request(app)
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
                Email: 'ravi@test.com',
                Organs: ['Kidney'],
                ConsentGiven: true
            });
        const donorId = donorResponse.body.donor._id;

        // Try to register and claim this donor with a DIFFERENT email — should be blocked.
        const mismatchResponse = await request(app)
            .post('/api/auth/register')
            .send({
                Name: 'Fake Ravi',
                Email: 'attacker@test.com',
                Password: 'password123',
                Role: 'donor',
                DonorId: donorId
            });
        expect(mismatchResponse.status).toBe(403);

        // Register with the MATCHING email — should succeed and link.
        const matchResponse = await request(app)
            .post('/api/auth/register')
            .send({
                Name: 'Ravi Kumar',
                Email: 'ravi@test.com',
                Password: 'password123',
                Role: 'donor',
                DonorId: donorId
            });
        expect(matchResponse.status).toBe(201);
        expect(matchResponse.body.user.LinkedDonor).toBe(donorId);
    });
});