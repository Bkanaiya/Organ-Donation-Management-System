const router = require('express').Router();
const catchAsync = require('../utils/catchAsync');
const { authenticate, authorize, authorizeSelfOrRoles, scopeHospitalIfHospitalRole } = require('../middleware/auth');
const receiverController = require('../controllers/receiver.controller');

router.post('/', catchAsync(receiverController.createReceiver));

// /me must come BEFORE /:id or Express would treat "me" as an :id value.
router.get('/me', authenticate, authorize('receiver'), catchAsync(receiverController.getMyReceiver));

// Hospital users get their authoritative Hospital pinned (the JWT carries no
// Hospital), admins and self-registered receivers pass through untouched.
router.get('/', authenticate, authorize('admin', 'hospital'), scopeHospitalIfHospitalRole, catchAsync(receiverController.listReceivers));

router.get('/:id', authenticate, authorizeSelfOrRoles('LinkedReceiver', 'id', 'admin', 'hospital'), scopeHospitalIfHospitalRole, catchAsync(receiverController.getReceiverById));

router.patch('/:id', authenticate, authorize('admin', 'hospital'), scopeHospitalIfHospitalRole, catchAsync(receiverController.updateReceiver));

module.exports = router;
