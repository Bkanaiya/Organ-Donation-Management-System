const express = require('express');
const mongoose = require('mongoose');
const Donor = require('./models/donor.model');
const Receiver = require('./models/receiver.model');
const Hospital = require('./models/hospital.model');
const Match = require('./models/match.model');
const { validateLocation, getDistrictsForState } = require('./utils/location');
const { getCompatibleDonorBloodGroups, locationScore } = require('./utils/matching');

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

// GET /api/donor?organ=Kidney&bloodGroup=O+&state=Tamil+Nadu&status=available
// All filters are optional and combine with AND.
app.get('/api/donor', async (req, res) => {
    try {
        const { organ, bloodGroup, state, district, status } = req.query;
        const filter = {};

        if (organ) filter['OrgansDonated.Organ'] = organ;
        if (bloodGroup) filter.BloodGroup = bloodGroup;
        if (state) filter.State = state;
        if (district) filter.District = district;
        if (status) filter.Status = status;

        const donors = await Donor.find(filter).populate('Hospital', 'Name State District');
        res.status(200).json({ count: donors.length, donors });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

app.get('/api/donor/:id', async (req, res) => {
    try {
        const donor = await Donor.findById(req.params.id).populate('Hospital', 'Name State District');

        if (!donor) {
            return res.status(404).json({ message: 'donor not found' });
        }

        res.status(200).json({ donor });
    } catch (error) {
        // CastError happens when :id isn't a valid Mongo ObjectId
        if (error.name === 'CastError') {
            return res.status(400).json({ message: 'invalid donor id' });
        }
        res.status(500).json({ message: error.message });
    }
});

// PATCH /api/donor/:id — partial update, e.g. { "Status": "matched" } or
// updating the status of one organ inside OrgansDonated.
app.patch('/api/donor/:id', async (req, res) => {
    try {
        const donor = await Donor.findByIdAndUpdate(
            req.params.id,
            req.body,
            { new: true, runValidators: true }
        );

        if (!donor) {
            return res.status(404).json({ message: 'donor not found' });
        }

        res.status(200).json({ message: 'donor updated successfully', donor });
    } catch (error) {
        if (error.name === 'CastError') {
            return res.status(400).json({ message: 'invalid donor id' });
        }
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

// GET /api/receiver?organ=Kidney&bloodGroup=O+&urgency=critical&status=waiting
app.get('/api/receiver', async (req, res) => {
    try {
        const { organ, bloodGroup, urgency, state, district, status } = req.query;
        const filter = {};

        if (organ) filter.Organ_needed = organ;
        if (bloodGroup) filter.BloodGroup = bloodGroup;
        if (urgency) filter.Urgency = urgency;
        if (state) filter.State = state;
        if (district) filter.District = district;
        if (status) filter.Status = status;

        // Most urgent first, then longest-waiting first.
        const urgencyOrder = { critical: 0, urgent: 1, stable: 2 };
        const receivers = await Receiver.find(filter)
            .populate('Hospital', 'Name State District')
            .sort({ WaitlistDate: 1 });

        receivers.sort((a, b) => urgencyOrder[a.Urgency] - urgencyOrder[b.Urgency]);

        res.status(200).json({ count: receivers.length, receivers });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

app.get('/api/receiver/:id', async (req, res) => {
    try {
        const receiver = await Receiver.findById(req.params.id).populate('Hospital', 'Name State District');

        if (!receiver) {
            return res.status(404).json({ message: 'receiver not found' });
        }

        res.status(200).json({ receiver });
    } catch (error) {
        if (error.name === 'CastError') {
            return res.status(400).json({ message: 'invalid receiver id' });
        }
        res.status(500).json({ message: error.message });
    }
});

app.patch('/api/receiver/:id', async (req, res) => {
    try {
        const receiver = await Receiver.findByIdAndUpdate(
            req.params.id,
            req.body,
            { new: true, runValidators: true }
        );

        if (!receiver) {
            return res.status(404).json({ message: 'receiver not found' });
        }

        res.status(200).json({ message: 'receiver updated successfully', receiver });
    } catch (error) {
        if (error.name === 'CastError') {
            return res.status(400).json({ message: 'invalid receiver id' });
        }
        res.status(400).json({ message: error.message });
    }
});

// --- Match ----------------------------------------------------------------

// GET /api/match/suggest/:receiverId
// Finds compatible, available donors for a given receiver: same organ,
// blood-type compatible (not just identical), ranked by location proximity.
app.get('/api/match/suggest/:receiverId', async (req, res) => {
    try {
        const receiver = await Receiver.findById(req.params.receiverId);

        if (!receiver) {
            return res.status(404).json({ message: 'receiver not found' });
        }

        const compatibleBloodGroups = getCompatibleDonorBloodGroups(receiver.BloodGroup);

        const candidates = await Donor.find({
            BloodGroup: { $in: compatibleBloodGroups },
            OrgansDonated: {
                $elemMatch: { Organ: receiver.Organ_needed, Status: 'available' }
            }
        }).populate('Hospital', 'Name State District');

        const ranked = candidates
            .map((donor) => ({
                donor,
                locationScore: locationScore(donor, receiver)
            }))
            .sort((a, b) => a.locationScore - b.locationScore)
            .map(({ donor, locationScore }) => ({
                _id: donor._id,
                Name: donor.Name,
                Age: donor.Age,
                BloodGroup: donor.BloodGroup,
                DonorType: donor.DonorType,
                State: donor.State,
                District: donor.District,
                ContactNumber: donor.ContactNumber,
                Hospital: donor.Hospital,
                matchQuality: locationScore === 0 ? 'same district' : locationScore === 1 ? 'same state' : 'other location'
            }));

        res.status(200).json({
            receiver: {
                _id: receiver._id,
                Name: receiver.Name,
                Organ_needed: receiver.Organ_needed,
                BloodGroup: receiver.BloodGroup,
                Urgency: receiver.Urgency
            },
            compatibleBloodGroups,
            count: ranked.length,
            candidates: ranked
        });
    } catch (error) {
        if (error.name === 'CastError') {
            return res.status(400).json({ message: 'invalid receiver id' });
        }
        res.status(500).json({ message: error.message });
    }
});

app.post('/api/match', async (req, res) => {
    try {
        const { Donor: donorId, Receiver: receiverId, Organ, Hospital: hospitalId, Notes } = req.body;

        if (!donorId || !receiverId || !Organ || !hospitalId) {
            return res.status(400).json({ message: 'Donor, Receiver, Organ, and Hospital are required' });
        }

        const donor = await Donor.findById(donorId);
        if (!donor) {
            return res.status(404).json({ message: 'donor not found' });
        }

        const organEntry = donor.OrgansDonated.find((o) => o.Organ === Organ);
        if (!organEntry) {
            return res.status(400).json({ message: `donor has not offered ${Organ}` });
        }
        if (organEntry.Status !== 'available') {
            return res.status(409).json({ message: `this donor's ${Organ} is already ${organEntry.Status}, not available` });
        }

        const receiver = await Receiver.findById(receiverId);
        if (!receiver) {
            return res.status(404).json({ message: 'receiver not found' });
        }

        const match = await Match.create({
            Donor: donorId,
            Receiver: receiverId,
            Organ,
            Hospital: hospitalId,
            Notes
        });

        // Reflect the match on both sides so future queries (and /api/match/suggest)
        // no longer treat this organ or this receiver as still waiting.
        organEntry.Status = 'matched';
        await donor.save();

        receiver.Status = 'matched';
        await receiver.save();

        res.status(201).json({ message: 'match created successfully', match });
    } catch (error) {
        if (error.name === 'CastError') {
            return res.status(400).json({ message: 'invalid donor, receiver, or hospital id' });
        }
        res.status(400).json({ message: error.message });
    }
});

module.exports = app;