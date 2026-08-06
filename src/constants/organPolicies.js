const AppError = require('../utils/AppError');

// Each organ has its own allocation policy. The matcher reads this file to
// decide:
//   - what score weights to use (scoring.js),
//   - what clinical checks are required (eligibility.service.js),
//   - what statuses a receiver must be in to be a candidate,
//   - what the cold-ischemia budget is for that organ,
//   - what phases the allocation workflow passes through.
//
// `version` is captured on every Match so a policy change doesn't retroactively
// re-grade historical matches. Add a new organ by adding an entry here; the
// matcher and eligibility engine both consult getOrganPolicy().

// Score factors are 0..100 and renormalized by the weights — see scoring.js.
function kidneyPolicy() {
    return {
        version: '2026.08.0',
        scoreWeights: {
            location: 0.15,
            urgency: 0.20,
            waitingTime: 0.15,
            ageProximity: 0.05,
            sizeMatch: 0.05,
            hlaMatch: 0.30,
            coldIschemiaRemaining: 0.10
        },
        ageLimit: { min: 0, max: 75, idealMax: 60 },
        weightMatch: { tolerance_grams: 200 },
        HLA_matchRequired: { minMatches: 2, loci: ['DR', 'B'] },
        crossmatchRequired: true,
        cPRA_matchRequired: true,
        coldIschemiaLimit_min: 1440,           // 24h
        coldIschemiaRemainingThreshold_min: 60,
        infectionScreenRequired: ['HIV', 'HepB', 'HepC', 'CMV', 'EBV', 'Syphilis'],
        acceptsExtendedCriteria: true,
        pediatricAllowed: true,
        acceptsReceiverStatuses: ['waiting'],
        // Reserved -> crossmatch_confirmed -> accepted are the live phases;
        // the rest are terminal. New workflow endpoints (approve / cancel /
        // complete) advance the phase.
        workflow: ['suggested', 'reserved', 'crossmatch_confirmed', 'accepted', 'in_progress', 'completed']
    };
}

function liverPolicy() {
    return {
        version: '2026.08.0',
        scoreWeights: {
            location: 0.20,
            urgency: 0.35,
            waitingTime: 0.20,
            ageProximity: 0.10,
            sizeMatch: 0.10,
            hlaMatch: 0,
            coldIschemiaRemaining: 0.05
        },
        ageLimit: { min: 0, max: 80, idealMax: 65 },
        weightMatch: { tolerance_grams: 500 },
        HLA_matchRequired: false,
        crossmatchRequired: false,
        cPRA_matchRequired: false,
        coldIschemiaLimit_min: 720,            // 12h
        coldIschemiaRemainingThreshold_min: 30,
        infectionScreenRequired: ['HIV', 'HepB', 'HepC'],
        acceptsExtendedCriteria: true,
        pediatricAllowed: true,
        acceptsReceiverStatuses: ['waiting'],
        workflow: ['suggested', 'reserved', 'accepted', 'in_progress', 'completed'],
        // Future hook: when a MELD score is available on the receiver, prefer
        // medical-urgency ordering over plain Urgency.
        priorityOverride: 'MELD_score'
    };
}

function heartPolicy() {
    return {
        version: '2026.08.0',
        scoreWeights: {
            location: 0.20,
            urgency: 0.40,
            waitingTime: 0.15,
            ageProximity: 0.10,
            sizeMatch: 0.10,
            hlaMatch: 0,
            coldIschemiaRemaining: 0.05
        },
        ageLimit: { min: 0, max: 65, idealMax: 55 },
        weightMatch: { tolerance_grams: 100 },
        HLA_matchRequired: false,
        crossmatchRequired: false,
        cPRA_matchRequired: false,
        coldIschemiaLimit_min: 240,            // 4h
        coldIschemiaRemainingThreshold_min: 30,
        infectionScreenRequired: ['HIV', 'HepB', 'HepC'],
        acceptsExtendedCriteria: false,
        pediatricAllowed: true,
        acceptsReceiverStatuses: ['waiting'],
        workflow: ['suggested', 'reserved', 'accepted', 'in_progress', 'completed']
    };
}

function lungsPolicy() {
    return {
        version: '2026.08.0',
        scoreWeights: {
            location: 0.20,
            urgency: 0.30,
            waitingTime: 0.20,
            ageProximity: 0.10,
            sizeMatch: 0.15,
            hlaMatch: 0,
            coldIschemiaRemaining: 0.05
        },
        ageLimit: { min: 0, max: 70, idealMax: 60 },
        weightMatch: { tolerance_grams: 150 },
        HLA_matchRequired: false,
        crossmatchRequired: false,
        coldIschemiaLimit_min: 360,            // 6h
        coldIschemiaRemainingThreshold_min: 30,
        infectionScreenRequired: ['HIV', 'HepB', 'HepC'],
        acceptsExtendedCriteria: false,
        pediatricAllowed: false,
        acceptsReceiverStatuses: ['waiting'],
        workflow: ['suggested', 'reserved', 'accepted', 'in_progress', 'completed']
    };
}

function corneaPolicy() {
    return {
        version: '2026.08.0',
        scoreWeights: {
            location: 0.25,
            urgency: 0.30,
            waitingTime: 0.30,
            ageProximity: 0.10,
            sizeMatch: 0,
            hlaMatch: 0,
            coldIschemiaRemaining: 0.05
        },
        ageLimit: { min: 0, max: 90, idealMax: 75 },
        HLA_matchRequired: false,
        crossmatchRequired: false,
        coldIschemiaLimit_min: 7200,           // 5 days
        coldIschemiaRemainingThreshold_min: 60,
        infectionScreenRequired: ['HIV', 'HepB', 'HepC', 'Syphilis'],
        acceptsExtendedCriteria: true,
        // Tissues are accepted before the receiver reaches "waiting" status.
        pediatricAllowed: true,
        acceptsReceiverStatuses: ['verified', 'waiting'],
        workflow: ['suggested', 'reserved', 'accepted', 'in_progress', 'completed']
    };
}

function boneMarrowPolicy() {
    return {
        version: '2026.08.0',
        scoreWeights: {
            location: 0.10,
            urgency: 0.15,
            waitingTime: 0.10,
            ageProximity: 0.05,
            sizeMatch: 0,
            hlaMatch: 0.60,
            coldIschemiaRemaining: 0
        },
        ageLimit: { min: 0, max: 80, idealMax: 60 },
        HLA_matchRequired: { minMatches: 6, loci: ['A', 'B', 'DR'] },
        crossmatchRequired: true,
        coldIschemiaLimit_min: 0,              // not applicable
        coldIschemiaRemainingThreshold_min: 0,
        infectionScreenRequired: ['HIV', 'HepB', 'HepC', 'CMV', 'EBV'],
        acceptsExtendedCriteria: false,
        pediatricAllowed: true,
        acceptsReceiverStatuses: ['waiting'],
        workflow: ['suggested', 'reserved', 'crossmatch_confirmed', 'accepted', 'in_progress', 'completed']
    };
}

function skinPolicy() {
    return {
        version: '2026.08.0',
        scoreWeights: {
            location: 0.30,
            urgency: 0.30,
            waitingTime: 0.25,
            ageProximity: 0.10,
            sizeMatch: 0,
            hlaMatch: 0,
            coldIschemiaRemaining: 0.05
        },
        ageLimit: { min: 0, max: 90, idealMax: 75 },
        HLA_matchRequired: false,
        crossmatchRequired: false,
        coldIschemiaLimit_min: 4320,           // 3 days
        coldIschemiaRemainingThreshold_min: 60,
        infectionScreenRequired: ['HIV', 'HepB', 'HepC', 'Syphilis'],
        acceptsExtendedCriteria: true,
        pediatricAllowed: true,
        acceptsReceiverStatuses: ['verified', 'waiting'],
        workflow: ['suggested', 'reserved', 'accepted', 'in_progress', 'completed']
    };
}

const POLICIES = {
    Kidney: kidneyPolicy,
    Liver: liverPolicy,
    Heart: heartPolicy,
    Lungs: lungsPolicy,
    Cornea: corneaPolicy,
    'Bone Marrow': boneMarrowPolicy,
    Skin: skinPolicy
};

// Returns the policy for an organ name. Throws AppError(400) for any organ
// the registry doesn't know about — better to fail loud at match time than
// silently apply the wrong rules.
function getOrganPolicy(organName) {
    const factory = POLICIES[organName];
    if (!factory) {
        throw new AppError(`unknown organ: ${organName}`, 400);
    }
    return factory();
}

module.exports = { getOrganPolicy, POLICIES };