const donorService = require('../services/donor.service');

async function createDonor(req, res) {
    const donor = await donorService.createDonor(req.body);
    res.status(201).json({ message: 'donor created successfully', donor });
}

async function getMyDonor(req, res) {
    const donor = await donorService.getMyDonor(req.user.LinkedDonor);
    res.status(200).json({ donor });
}

async function listDonors(req, res) {
    const donors = await donorService.listDonors(req.query);
    res.status(200).json({ count: donors.length, donors });
}

async function getDonorById(req, res) {
    const donor = await donorService.getDonorById(req.params.id);
    res.status(200).json({ donor });
}

async function updateDonor(req, res) {
    const user = {
        id: req.user.id || req.user._id,
        Role: req.user.Role,
        Hospital: req.user.Hospital
    };
    const donor = await donorService.updateDonor(req.params.id, req.body, user, req);
    res.status(200).json({ message: 'donor updated successfully', donor });
}

module.exports = { createDonor, getMyDonor, listDonors, getDonorById, updateDonor };
