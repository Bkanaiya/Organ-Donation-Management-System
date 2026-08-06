const AppError = require('../utils/AppError');
const Hospital = require('../models/hospital.model');
const { validateLocation } = require('../utils/location');

async function createHospital(payload) {
    const { Name, RegistrationNumber, State, District, Address, ContactNumber, Email } = payload;

    const location = validateLocation(State, District);
    if (!location.ok) {
        throw new AppError(location.message, location.status);
    }

    return Hospital.create({
        Name, RegistrationNumber, State, District, Address, ContactNumber, Email
    });
}

module.exports = { createHospital };
