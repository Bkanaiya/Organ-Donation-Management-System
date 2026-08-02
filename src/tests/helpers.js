const request = require('supertest');
const app = require('../app');

// Registers an admin and returns their token — most match/hospital tests need this first.
async function createAdminAndToken() {
    const response = await request(app)
        .post('/api/auth/register')
        .send({
            Name: 'Admin',
            Email: `admin-${Date.now()}-${Math.random()}@test.com`,
            Password: 'password123',
            Role: 'admin'
        });
    return response.body.token;
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

async function createDonor(hospitalId, overrides = {}) {
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
            Hospital: hospitalId,
            ConsentGiven: true,
            ...overrides
        });
    return response.body.donor;
}

async function createReceiver(hospitalId, overrides = {}) {
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
            Hospital: hospitalId,
            ...overrides
        });
    return response.body.receiver;
}

module.exports = { createAdminAndToken, createHospital, createDonor, createReceiver };