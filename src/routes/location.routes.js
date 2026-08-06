const router = require('express').Router();
const catchAsync = require('../utils/catchAsync');
const locationController = require('../controllers/location.controller');

// Throwing inside a sync handler is fine — catchAsync would forward it but
// isn't strictly needed for the throw itself. Kept for consistency.
router.post('/', catchAsync(locationController.listDistricts));

module.exports = router;
