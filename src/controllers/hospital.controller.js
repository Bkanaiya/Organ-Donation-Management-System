const hospitalService = require('../services/hospital.service');

async function createHospital(req, res) {
    const hospital = await hospitalService.createHospital(req.body);
    res.status(201).json({ message: 'hospital created successfully', hospital });
}

module.exports = { createHospital };
