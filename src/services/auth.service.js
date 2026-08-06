const Donor = require('../models/donor.model');
const Receiver = require('../models/receiver.model');
const User = require('../models/user.model');
const { hashPassword, comparePassword, generateToken, DUMMY_HASH } = require('../utils/auth');
const AppError = require('../utils/AppError');

// Parses the body, normalizes the email, validates any donor/receiver link
// claim, creates the User, and returns the public user shape plus a token.
//
// SECURITY: this endpoint is publicly reachable, so it must NOT accept a
// caller-supplied Role. Without this guard, anyone could self-register as
// 'admin' or 'hospital' and escalate privileges. Role is hard-coded to
// 'donor' here; admin/hospital users are created out-of-band by an existing
// admin (or a seed script) through a privileged path.
// `Hospital`, `LinkedDonor`, `LinkedReceiver` are also dropped from the
// payload — they are derived from the validated DonorId/ReceiverId lookups
// (or left empty for a plain donor account), never trusted from the client.
async function register({ Name, Email, Password, DonorId, ReceiverId }) {
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
    if (DonorId) {
        const donorRecord = await Donor.findById(DonorId);
        if (!donorRecord) {
            throw new AppError('donor record not found', 404);
        }
        if ((donorRecord.Email || '').toLowerCase().trim() !== normalizedEmail) {
            throw new AppError('email does not match this donor record', 403);
        }
        linkedDonor = donorRecord._id;
    }

    if (ReceiverId) {
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

    // Role is server-assigned — never taken from the request body. Hospital
    // linkage likewise stays server-controlled (empty for self-registered
    // donors; admins/hospitals are provisioned through a privileged path).
    const user = await User.create({
        Name,
        Email,
        Password: hashedPassword,
        Role: 'donor',
        LinkedDonor: linkedDonor,
        LinkedReceiver: linkedReceiver
    });

    const token = generateToken(user);

    return {
        token,
        user: {
            _id: user._id,
            Name: user.Name,
            Email: user.Email,
            Role: user.Role,
            LinkedDonor: user.LinkedDonor,
            LinkedReceiver: user.LinkedReceiver
        }
    };
}

// Validates credentials and issues a token. Returns the public user shape
// plus the token — both pieces the controller needs to send back.
async function login({ Email, Password }) {
    if (!Email || !Password) {
        throw new AppError('Email and Password are required', 400);
    }

    // Password has `select: false` on the schema, so it must be explicitly requested here.
    const user = await User.findOne({ Email: Email.toLowerCase().trim() }).select('+Password');

    if (!user) {
        // Burn the same CPU as a real bcrypt comparison so an attacker
        // can't enumerate registered emails via response-time differences.
        await comparePassword(Password, DUMMY_HASH);
        throw new AppError('invalid email or password', 401);
    }

    const isMatch = await comparePassword(Password, user.Password);
    if (!isMatch) {
        throw new AppError('invalid email or password', 401);
    }

    const token = generateToken(user);

    return {
        token,
        user: { _id: user._id, Name: user.Name, Email: user.Email, Role: user.Role }
    };
}

module.exports = { register, login };
