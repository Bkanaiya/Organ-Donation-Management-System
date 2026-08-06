const router = require('express').Router();
const catchAsync = require('../utils/catchAsync');
const authController = require('../controllers/auth.controller');

router.post('/register', catchAsync(authController.register));
router.post('/login', catchAsync(authController.login));

module.exports = router;
