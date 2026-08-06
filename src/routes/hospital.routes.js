const router = require('express').Router();
const catchAsync = require('../utils/catchAsync');
const { authenticate, authorize } = require('../middleware/auth');
const hospitalController = require('../controllers/hospital.controller');

router.post('/', authenticate, authorize('admin'), catchAsync(hospitalController.createHospital));

module.exports = router;
