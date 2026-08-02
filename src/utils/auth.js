const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

async function hashPassword(plainPassword) {
    const salt = await bcrypt.genSalt(10);
    return bcrypt.hash(plainPassword, salt);
}

async function comparePassword(plainPassword, hashedPassword) {
    return bcrypt.compare(plainPassword, hashedPassword);
}

function generateToken(user) {
    return jwt.sign(
        {
            id: user._id,
            Role: user.Role,
            LinkedDonor: user.LinkedDonor,
            LinkedReceiver: user.LinkedReceiver
        },
        process.env.JWT_SECRET,
        { expiresIn: '7d' }
    );
}

function verifyToken(token) {
    return jwt.verify(token, process.env.JWT_SECRET);
}

module.exports = { hashPassword, comparePassword, generateToken, verifyToken };