const matchService = require('../services/match.service');

// `req.user.Hospital` is the live, DB-resolved id set by `scopeToHospital`.
// For admins the middleware short-circuits and leaves it undefined, which
// the service treats as "no scope filter" — preserves existing admin behavior.
// `req.id` is set by pino-http (genReqId) — it correlates log lines and audit
// rows so a single ranking decision can be traced end-to-end.
async function suggestMatches(req, res) {
    const result = await matchService.suggestMatchesForReceiver(req.params.receiverId, req.user.Hospital, req);
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

module.exports = { suggestMatches, createMatch };