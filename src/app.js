const express = require('express');
const mongoose = require('mongoose');
const Donor = require('./models/donor.model');
const Receiver = require('./models/receiver.model');
const Hospital = require('./models/hospital.model');
const Match = require('./models/match.model');
const User = require('./models/user.model');
const { validateLocation, getDistrictsForState } = require('./utils/location');
const { getCompatibleDonorBloodGroups, locationScore } = require('./utils/matching');
const { hashPassword, comparePassword, generateToken } = require('./utils/auth');
const { authenticate, authorize, authorizeSelfOrRoles } = require('./middleware/auth');
const catchAsync = require('./utils/catchAsync');
const AppError = require('./utils/AppError');
const errorHandler = require('./middleware/errorHandler');

const app = express();
app.use(express.json());

app.get('/', (req, res) => {
    res.send('Organ Donation API is running');
});

// --- Auth -------------------------------------------------------------
app.post('/api/auth/register', catchAsync(async (req, res) => {
    const { Name, Email, Password, Role, Hospital: hospitalId, DonorId, ReceiverId } = req.body;

    if (!Name || !Email || !Password) {
        throw new AppError('Name, Email, and Password are required', 400);
    }

    const normalizedEmail = Email.toLowerCase().trim();

    const existing = await User.findOne({ Email: normalizedEmail });
    if (existing) {
        throw new AppError('an account with this email already exists', 409);
    }

    let linkedDonor;
    let linkedReceiver;

    // Only let someone claim a Donor/Receiver record if the email on that
    // record actually matches the email they're registering with — otherwise
    // anyone could pass an arbitrary ID and see someone else's data.
    if (Role === 'donor' && DonorId) {
        const donorRecord = await Donor.findById(DonorId);
        if (!donorRecord) {
            throw new AppError('donor record not found', 404);
        }
        if ((donorRecord.Email || '').toLowerCase().trim() !== normalizedEmail) {
            throw new AppError('email does not match this donor record', 403);
        }
        linkedDonor = donorRecord._id;
    }

    if (Role === 'receiver' && ReceiverId) {
        const receiverRecord = await Receiver.findById(ReceiverId);
        if (!receiverRecord) {
            throw new AppError('receiver record not found', 404);
        }
        if ((receiverRecord.Email || '').toLowerCase().trim() !== normalizedEmail) {
            throw new AppError('email does not match this receiver record', 403);
        }
        linkedReceiver = receiverRecord._id;
    }

    const hashedPassword = await hashPassword(Password);

    const user = await User.create({
        Name,
        Email,
        Password: hashedPassword,
        Role,
        Hospital: hospitalId,
        LinkedDonor: linkedDonor,
        LinkedReceiver: linkedReceiver
    });

    const token = generateToken(user);

    res.status(201).json({
        message: 'account created successfully',
        token,
        user: {
            _id: user._id,
            Name: user.Name,
            Email: user.Email,
            Role: user.Role,
            LinkedDonor: user.LinkedDonor,
            LinkedReceiver: user.LinkedReceiver
        }
    });
}));

app.post('/api/auth/login', catchAsync(async (req, res) => {
    const { Email, Password } = req.body;

    if (!Email || !Password) {
        throw new AppError('Email and Password are required', 400);
    }

    // Password has `select: false` on the schema, so it must be explicitly requested here.
    const user = await User.findOne({ Email: Email.toLowerCase().trim() }).select('+Password');

    if (!user) {
        throw new AppError('invalid email or password', 401);
    }

    const isMatch = await comparePassword(Password, user.Password);
    if (!isMatch) {
        throw new AppError('invalid email or password', 401);
    }

    const token = generateToken(user);

    res.status(200).json({
        message: 'login successful',
        token,
        user: { _id: user._id, Name: user.Name, Email: user.Email, Role: user.Role }
    });
}));

app.post('/api/districts', (req, res) => {
    const { state } = req.body;

    if (!state) {
        throw new AppError('State is required', 400);
    }

    const districts = getDistrictsForState(state);

    if (!districts) {
        throw new AppError('State not found. Please choose a state from India.', 404);
    }

    res.status(200).json({
        state: state.trim(),
        districts
    });
});

// --- Hospital -------------------------------------------------------------
app.post('/api/hospital', authenticate, authorize('admin'), catchAsync(async (req, res) => {
    const { Name, RegistrationNumber, State, District, Address, ContactNumber, Email } = req.body;

    const location = validateLocation(State, District);
    if (!location.ok) {
        throw new AppError(location.message, location.status);
    }

    const hospital = await Hospital.create({
        Name, RegistrationNumber, State, District, Address, ContactNumber, Email
    });

    res.status(201).json({ message: 'hospital created successfully', hospital });
}));

// --- Donor ------------------------------------------------------------------
app.post('/api/donor', catchAsync(async (req, res) => {
    const {
        Name, Age, Gender, BloodGroup, DonorType,
        State, District, ContactNumber, Email,
        Organs,
        Hospital: hospitalId,
        ConsentGiven
    } = req.body;

    const location = validateLocation(State, District);
    if (!location.ok) {
        throw new AppError(location.message, location.status);
    }

    if (!Array.isArray(Organs) || Organs.length === 0) {
        throw new AppError('at least one organ is required', 400);
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
}));

// GET /api/donor/me — a logged-in donor's own record, no id needed.
// Must come before /api/donor/:id or Express would treat "me" as an :id value.
app.get('/api/donor/me', authenticate, authorize('donor'), catchAsync(async (req, res) => {
    if (!req.user.LinkedDonor) {
        throw new AppError('this account is not linked to a donor record', 404);
    }

    const donor = await Donor.findById(req.user.LinkedDonor).populate('Hospital', 'Name State District');

    if (!donor) {
        throw new AppError('linked donor record not found', 404);
    }

    res.status(200).json({ donor });
}));

// GET /api/donor?organ=Kidney&bloodGroup=O+&state=Tamil+Nadu&status=available
// All filters are optional and combine with AND.
app.get('/api/donor', authenticate, authorize('admin', 'hospital'), catchAsync(async (req, res) => {
    const { organ, bloodGroup, state, district, status } = req.query;
    const filter = {};

    if (organ) filter['OrgansDonated.Organ'] = organ;
    if (bloodGroup) filter.BloodGroup = bloodGroup;
    if (state) filter.State = state;
    if (district) filter.District = district;
    if (status) filter.Status = status;

    const donors = await Donor.find(filter).populate('Hospital', 'Name State District');
    res.status(200).json({ count: donors.length, donors });
}));

app.get('/api/donor/:id', authenticate, authorizeSelfOrRoles('LinkedDonor', 'id', 'admin', 'hospital'), catchAsync(async (req, res) => {
    const donor = await Donor.findById(req.params.id).populate('Hospital', 'Name State District');

    if (!donor) {
        throw new AppError('donor not found', 404);
    }

    res.status(200).json({ donor });
}));

// PATCH /api/donor/:id — partial update, e.g. { "Status": "matched" } or
// updating the status of one organ inside OrgansDonated.
app.patch('/api/donor/:id', authenticate, authorize('admin', 'hospital'), catchAsync(async (req, res) => {
    const donor = await Donor.findByIdAndUpdate(
        req.params.id,
        req.body,
        { new: true, runValidators: true }
    );

    if (!donor) {
        throw new AppError('donor not found', 404);
    }

    res.status(200).json({ message: 'donor updated successfully', donor });
}));

// --- Receiver -----------------------------------------------------------
app.post('/api/receiver', catchAsync(async (req, res) => {
    const {
        Name, Age, Gender, BloodGroup,
        State, District, ContactNumber, Email,
        Organ_needed, Urgency,
        Hospital: hospitalId
    } = req.body;

    const location = validateLocation(State, District);
    if (!location.ok) {
        throw new AppError(location.message, location.status);
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
}));

// GET /api/receiver/me — a logged-in receiver's own record, no id needed.
// Must come before /api/receiver/:id or Express would treat "me" as an :id value.
app.get('/api/receiver/me', authenticate, authorize('receiver'), catchAsync(async (req, res) => {
    if (!req.user.LinkedReceiver) {
        throw new AppError('this account is not linked to a receiver record', 404);
    }

    const receiver = await Receiver.findById(req.user.LinkedReceiver).populate('Hospital', 'Name State District');

    if (!receiver) {
        throw new AppError('linked receiver record not found', 404);
    }

    res.status(200).json({ receiver });
}));

// GET /api/receiver?organ=Kidney&bloodGroup=O+&urgency=critical&status=waiting
app.get('/api/receiver', authenticate, authorize('admin', 'hospital'), catchAsync(async (req, res) => {
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
}));

app.get('/api/receiver/:id', authenticate, authorizeSelfOrRoles('LinkedReceiver', 'id', 'admin', 'hospital'), catchAsync(async (req, res) => {
    const receiver = await Receiver.findById(req.params.id).populate('Hospital', 'Name State District');

    if (!receiver) {
        throw new AppError('receiver not found', 404);
    }

    res.status(200).json({ receiver });
}));

app.patch('/api/receiver/:id', authenticate, authorize('admin', 'hospital'), catchAsync(async (req, res) => {
    const receiver = await Receiver.findByIdAndUpdate(
        req.params.id,
        req.body,
        { new: true, runValidators: true }
    );

    if (!receiver) {
        throw new AppError('receiver not found', 404);
    }

    res.status(200).json({ message: 'receiver updated successfully', receiver });
}));

// --- Match ----------------------------------------------------------------

// GET /api/match/suggest/:receiverId
// Finds compatible, available donors for a given receiver: same organ,
// blood-type compatible (not just identical), ranked by location proximity.
app.get('/api/match/suggest/:receiverId', authenticate, authorize('admin', 'hospital'), catchAsync(async (req, res) => {
    const receiver = await Receiver.findById(req.params.receiverId);

    if (!receiver) {
        throw new AppError('receiver not found', 404);
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
}));

app.post('/api/match', authenticate, authorize('admin', 'hospital'), catchAsync(async (req, res) => {
    const { Donor: donorId, Receiver: receiverId, Organ, Hospital: hospitalId, Notes } = req.body;

    if (!donorId || !receiverId || !Organ || !hospitalId) {
        throw new AppError('Donor, Receiver, Organ, and Hospital are required', 400);
    }

    const donor = await Donor.findById(donorId);
    if (!donor) {
        throw new AppError('donor not found', 404);
    }

    const organEntry = donor.OrgansDonated.find((o) => o.Organ === Organ);
    if (!organEntry) {
        throw new AppError(`donor has not offered ${Organ}`, 400);
    }
    if (organEntry.Status !== 'available') {
        throw new AppError(`this donor's ${Organ} is already ${organEntry.Status}, not available`, 409);
    }

    const receiver = await Receiver.findById(receiverId);
    if (!receiver) {
        throw new AppError('receiver not found', 404);
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
}));

// --- 404 for unmatched routes ---------------------------------------------
// Must come after every real route and before the error handler.
app.use((req, res, next) => {
    next(new AppError(`route not found: ${req.method} ${req.originalUrl}`, 404));
});

// --- Central error handler --------------------------------------------
// Must be registered last — Express identifies it as an error handler
// specifically because it takes 4 arguments (err, req, res, next).
app.use(errorHandler);

module.exports = app;