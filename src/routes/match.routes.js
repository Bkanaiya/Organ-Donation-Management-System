const router = require('express').Router();
const catchAsync = require('../utils/catchAsync');
const { authenticate, authorize, scopeToHospital } = require('../middleware/auth');
const matchController = require('../controllers/match.controller');

// `scopeToHospital` runs after `authorize('admin', 'hospital')` so admins
// short-circuit and hospital users are scoped to their own hospital before
// the controller/service runs.
router.get('/suggest/:receiverId', authenticate, authorize('admin', 'hospital'), scopeToHospital, catchAsync(matchController.suggestMatches));

router.post('/', authenticate, authorize('admin', 'hospital'), scopeToHospital, catchAsync(matchController.createMatch));

// Allocation lifecycle — once a match is reserved it has to be advanceable
// to accepted/in_progress/completed (success path) or to cancelled/failed
// (release path). Without these endpoints a reservation strangs both
// donor organ and receiver in 'matched' forever.
router.get('/', authenticate, authorize('admin', 'hospital'), scopeToHospital, catchAsync(matchController.listMatches));
router.get('/:id/audit', authenticate, authorize('admin', 'hospital'), scopeToHospital, catchAsync(matchController.getMatchAudit));
router.get('/:id', authenticate, authorize('admin', 'hospital'), scopeToHospital, catchAsync(matchController.getMatch));
router.post('/:id/approve', authenticate, authorize('admin', 'hospital'), scopeToHospital, catchAsync(matchController.approveMatch));
router.post('/:id/crossmatch', authenticate, authorize('admin', 'hospital'), scopeToHospital, catchAsync(matchController.recordCrossmatch));
router.post('/:id/start', authenticate, authorize('admin', 'hospital'), scopeToHospital, catchAsync(matchController.startMatch));
router.post('/:id/complete', authenticate, authorize('admin', 'hospital'), scopeToHospital, catchAsync(matchController.completeMatch));
router.post('/:id/fail', authenticate, authorize('admin', 'hospital'), scopeToHospital, catchAsync(matchController.failMatch));
router.post('/:id/cancel', authenticate, authorize('admin', 'hospital'), scopeToHospital, catchAsync(matchController.cancelMatch));

module.exports = router;
