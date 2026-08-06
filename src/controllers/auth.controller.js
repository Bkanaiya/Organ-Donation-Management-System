const authService = require('../services/auth.service');

// Thin wrappers around authService — controllers own the HTTP shape
// (status code + JSON envelope), services own the business logic.

async function register(req, res) {
    const result = await authService.register(req.body);
    res.status(201).json({
        message: 'account created successfully',
        token: result.token,
        user: result.user
    });
}

async function login(req, res) {
    const result = await authService.login(req.body);
    res.status(200).json({
        message: 'login successful',
        token: result.token,
        user: result.user
    });
}

module.exports = { register, login };
