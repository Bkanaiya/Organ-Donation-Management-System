const matchService = require('../services/match.service');
const AppError = require('../utils/AppError');

// `req.user.Hospital` is the live, DB-resolved id set by `scopeToHospital`.
// For admins the middleware short-circuits and leaves it undefined, which
// the service treats as "no scope filter" — preserves existing admin behavior.
// `req.id` is set by pino-http (genReqId) — it correlates log lines and audit
// rows so a single ranking decision can be traced end-to-end.
async function suggestMatches(req, res) {
    // The service clamps the raw limit to [1, 200]; anything unparseable or
    // omitted falls back to the default. The raw string is passed through
    // (not pre-validated here) so the service stays the single source of
    // truth for the clamp policy.
    const result = await matchService.suggestMatchesForReceiver(req.params.receiverId, req.user.Hospital, req, req.query.limit);
    res.status(200).json(result);
}

async function createMatch(req, res) {
    const user = {
        id: req.user.id || req.user._id,
        Role: req.user.Role,
        Hospital: req.user.Hospital,
        requestId: req.id
    };
    const match = await matchService.createMatch({
        ...req.body,
        Hospital: req.user.Hospital || req.body.Hospital
    }, user, req);
    res.status(201).json({ message: 'match created successfully', match });
}

// All lifecycle endpoints share the same auth shape (admin/hospital only)
// and the same user-payload layout.
function buildUser(req) {
    return {
        id: req.user.id || req.user._id,
        Role: req.user.Role,
        Hospital: req.user.Hospital,
        requestId: req.id
    };
}

async function getMatch(req, res) {
    const match = await matchService.loadMatchForCaller(req.params.id, req.user.Hospital);
    res.status(200).json({ match });
}

async function approveMatch(req, res) {
    const match = await matchService.approveMatch(req.params.id, buildUser(req), req);
    res.status(200).json({ message: 'match approved', match });
}

async function recordCrossmatch(req, res) {
    const { Result, Method, Notes } = req.body;
    const { crossmatch, match } = await matchService.recordCrossmatch(
        req.params.id,
        { Result, Method, Notes },
        buildUser(req),
        req
    );
    const message = Result === 'positive'
        ? 'crossmatch positive — match cancelled'
        : 'crossmatch recorded — match advanced';
    res.status(200).json({ message, crossmatch, match });
}

async function startMatch(req, res) {
    const match = await matchService.startMatch(req.params.id, buildUser(req), req);
    res.status(200).json({ message: 'match started', match });
}

async function completeMatch(req, res) {
    const match = await matchService.completeMatch(req.params.id, buildUser(req), req);
    res.status(200).json({ message: 'match completed', match });
}

async function cancelMatch(req, res) {
    const reason = (req.body && req.body.reason) || '';
    const match = await matchService.cancelMatch(req.params.id, buildUser(req), reason, req);
    res.status(200).json({ message: 'match cancelled', match });
}

async function failMatch(req, res) {
    const reason = (req.body && req.body.reason) || '';
    const match = await matchService.failMatch(req.params.id, buildUser(req), reason, req);
    res.status(200).json({ message: 'match failed', match });
}

async function listMatches(req, res) {
    const { status, organ, limit } = req.query;
    const matches = await matchService.listMatches({
        callerHospitalId: req.user.Hospital,
        status,
        organ,
        limit
    });
    res.status(200).json({ count: matches.length, matches });
}

async function getMatchAudit(req, res) {
    const audits = await matchService.getMatchAuditTrail(req.params.id, req.user.Hospital);
    res.status(200).json({ count: audits.length, audits });
}

module.exports = {
    suggestMatches,
    createMatch,
    getMatch,
    approveMatch,
    recordCrossmatch,
    startMatch,
    completeMatch,
    cancelMatch,
    failMatch,
    listMatches,
    getMatchAudit
};