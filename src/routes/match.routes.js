const router = require('express').Router();
const catchAsync = require('../utils/catchAsync');
const { authenticate, authorize, scopeToHospital } = require('../middleware/auth');
const matchController = require('../controllers/match.controller');

// `scopeToHospital` runs after `authorize('admin', 'hospital')` so admins
// short-circuit and hospital users are scoped to their own hospital before
// the controller/service runs.
router.get('/suggest/:receiverId', authenticate, authorize('admin', 'hospital'), scopeToHospital, catchAsync(matchController.suggestMatches));

router.post('/', authenticate, authorize('admin', 'hospital'), scopeToHospital, catchAsync(matchController.createMatch));

module.exports = router;
