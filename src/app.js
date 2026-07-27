const express = require('express');
const mongoose = require('mongoose');
const Donor = require('./models/donor.model');
const Receiver = require('./models/receiver.model');
const Hospital = require('./models/hospital.model');
const Match = require('./models/match.model');
const { validateLocation, getDistrictsForState } = require('./utils/location');

const app = express();
app.use(express.json());

app.get('/', (req, res) => {
    res.send('Organ Donation API is running');
});

app.post('/api/districts', (req, res) => {
    const { state } = req.body;

    if (!state) {
        return res.status(400).json({ message: 'State is required' });
    }

    const districts = getDistrictsForState(state);

    if (!districts) {
        return res.status(404).json({
            message: 'State not found. Please choose a state from India.'
        });
    }

    res.status(200).json({
        state: state.trim(),
        districts
    });
});

// --- Hospital -------------------------------------------------------------
app.post('/api/hospital', async (req, res) => {
    try {
        const { Name, RegistrationNumber, State, District, Address, ContactNumber, Email } = req.body;

        const location = validateLocation(State, District);
        if (!location.ok) {
            return res.status(location.status).json({ message: location.message });
        }

        const hospital = await Hospital.create({
            Name, RegistrationNumber, State, District, Address, ContactNumber, Email
        });

        res.status(201).json({ message: 'hospital created successfully', hospital });
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
});

// --- Donor ------------------------------------------------------------------
app.post('/api/donor', async (req, res) => {
    try {
        const {
            Name, Age, Gender, BloodGroup, DonorType,
            State, District, ContactNumber, Email,
            Organs,
            Hospital: hospitalId,
            ConsentGiven
        } = req.body;

        const location = validateLocation(State, District);
        if (!location.ok) {
            return res.status(location.status).json({ message: location.message });
        }

        if (!Array.isArray(Organs) || Organs.length === 0) {
            return res.status(400).json({ message: 'at least one organ is required' });
        }

        const donor = await Donor.create({
            Name,
            Age,
            Gender,
            BloodGroup,
            DonorType,
            State,
            District,
            ContactNumber,
            Email,
            OrgansDonated: Organs.map((organ) => ({ Organ: organ, Status: 'available' })),
            Hospital: hospitalId,
            ConsentGiven,
            ConsentDate: ConsentGiven ? new Date() : undefined
        });

        res.status(201).json({ message: 'donor created successfully', donor });
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
});

// --- Receiver -----------------------------------------------------------
app.post('/api/receiver', async (req, res) => {
    try {
        const {
            Name, Age, Gender, BloodGroup,
            State, District, ContactNumber, Email,
            Organ_needed, Urgency,
            Hospital: hospitalId
        } = req.body;

        const location = validateLocation(State, District);
        if (!location.ok) {
            return res.status(location.status).json({ message: location.message });
        }

        const receiver = await Receiver.create({
            Name,
            Age,
            Gender,
            BloodGroup,
            State,
            District,
            ContactNumber,
            Email,
            Organ_needed,
            Urgency,
            Hospital: hospitalId
        });

        res.status(201).json({ message: 'receiver created successfully', receiver });
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
});

// --- Match ----------------------------------------------------------------
app.post('/api/match', async (req, res) => {
    try {
        const { Donor: donorId, Receiver: receiverId, Organ, Hospital: hospitalId, Notes } = req.body;

        if (!donorId || !receiverId || !Organ || !hospitalId) {
            return res.status(400).json({ message: 'Donor, Receiver, Organ, and Hospital are required' });
        }

        const match = await Match.create({
            Donor: donorId,
            Receiver: receiverId,
            Organ,
            Hospital: hospitalId,
            Notes
        });

        res.status(201).json({ message: 'match created successfully', match });
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
});

module.exports = app;