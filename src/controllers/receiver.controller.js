const receiverService = require('../services/receiver.service');

async function createReceiver(req, res) {
    const receiver = await receiverService.createReceiver(req.body);
    res.status(201).json({ message: 'receiver created successfully', receiver });
}

async function getMyReceiver(req, res) {
    const receiver = await receiverService.getMyReceiver(req.user.LinkedReceiver);
    res.status(200).json({ receiver });
}

async function listReceivers(req, res) {
    const receivers = await receiverService.listReceivers(req.query);
    res.status(200).json({ count: receivers.length, receivers });
}

async function getReceiverById(req, res) {
    const receiver = await receiverService.getReceiverById(req.params.id);
    res.status(200).json({ receiver });
}

async function updateReceiver(req, res) {
    const user = {
        id: req.user.id || req.user._id,
        Role: req.user.Role,
        Hospital: req.user.Hospital
    };
    const receiver = await receiverService.updateReceiver(req.params.id, req.body, user, req);
    res.status(200).json({ message: 'receiver updated successfully', receiver });
}

module.exports = { createReceiver, getMyReceiver, listReceivers, getReceiverById, updateReceiver };
