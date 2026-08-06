const router = require('express').Router();
const catchAsync = require('../utils/catchAsync');
const { authenticate, authorize, authorizeSelfOrRoles } = require('../middleware/auth');
const receiverController = require('../controllers/receiver.controller');

router.post('/', catchAsync(receiverController.createReceiver));

// /me must come BEFORE /:id or Express would treat "me" as an :id value.
router.get('/me', authenticate, authorize('receiver'), catchAsync(receiverController.getMyReceiver));

router.get('/', authenticate, authorize('admin', 'hospital'), catchAsync(receiverController.listReceivers));

router.get('/:id', authenticate, authorizeSelfOrRoles('LinkedReceiver', 'id', 'admin', 'hospital'), catchAsync(receiverController.getReceiverById));

router.patch('/:id', authenticate, authorize('admin', 'hospital'), catchAsync(receiverController.updateReceiver));

module.exports = router;
