const router = require('express').Router();
const catchAsync = require('../utils/catchAsync');
const { authenticate, authorize, authorizeSelfOrRoles } = require('../middleware/auth');
const donorController = require('../controllers/donor.controller');

router.post('/', catchAsync(donorController.createDonor));

// /me must come BEFORE /:id or Express would treat "me" as an :id value.
router.get('/me', authenticate, authorize('donor'), catchAsync(donorController.getMyDonor));

router.get('/', authenticate, authorize('admin', 'hospital'), catchAsync(donorController.listDonors));

router.get('/:id', authenticate, authorizeSelfOrRoles('LinkedDonor', 'id', 'admin', 'hospital'), catchAsync(donorController.getDonorById));

router.patch('/:id', authenticate, authorize('admin', 'hospital'), catchAsync(donorController.updateDonor));

module.exports = router;
