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
// Every pediatricAllowed policy carries a pediatricPriority weight: pediatric
// receivers (Age < 18) score 100 on that factor, adults score 0, so the
// weight is pure ranking signal for pediatric candidates. Tissue policies
// (cornea/skin/bone/valve) carry urgency weight 0 — the critical/urgent/stable
// enum is clinically meaningless for elective grafts, so urgency must not
// move their ranking.

function kidneyPolicy() {
    return {
        version: '2026.09.0',
        scoreWeights: {
            location: 0.15,
            urgency: 0.20,
            waitingTime: 0.15,
            ageProximity: 0.05,
            pediatricPriority: 0.05,
            sizeMatch: 0.05,
            hlaMatch: 0.25,
            coldIschemiaRemaining: 0.10
        },
        ageLimit: { min: 0, max: 75, idealMax: 60 },
        weightMatch: { tolerance_grams: 200 },
        // Weighted HLA: DR and B are weighted equally for kidney; the weighted
        // score (0..100) is the SAME metric eligibility gates on (minHlaScore)
        // and scoring ranks by, so a pair can't pass one gate and score a
        // wildly different value on the other. minHlaScore 50 preserves the
        // old "2 antigen matches across DR+B" rule under the diploid
        // normalization (2/4 matched alleles = 50).
        HLA_matchRequired: { minHlaScore: 50, loci: ['DR', 'B'], locusWeights: { DR: 0.5, B: 0.5 } },
        crossmatchRequired: true,
        antibodyScreenRequired: true,
        coldIschemiaLimit_min: 1440,           // 24h
        coldIschemiaRemainingThreshold_min: 60,
        infectionScreenRequired: ['HIV', 'HepB', 'HepC', 'CMV', 'EBV', 'Syphilis'],
        acceptsExtendedCriteria: true,
        pediatricAllowed: true,
        acceptsReceiverStatuses: ['waiting'],
        // 3-year scale — waiting time matters for kidney but a >3y waiver
        // should not all tie at 100.
        waitingTimeCapDays: 1095,
        workflow: ['suggested', 'reserved', 'crossmatch_confirmed', 'accepted', 'in_progress', 'completed']
    };
}

function liverPolicy() {
    return {
        version: '2026.09.0',
        scoreWeights: {
            location: 0.20,
            urgency: 0.30,
            waitingTime: 0.20,
            ageProximity: 0.05,
            pediatricPriority: 0.10,
            sizeMatch: 0.10,
            hlaMatch: 0,
            coldIschemiaRemaining: 0.05
        },
        ageLimit: { min: 0, max: 80, idealMax: 65 },
        weightMatch: { tolerance_grams: 500 },
        HLA_matchRequired: false,
        crossmatchRequired: false,
        antibodyScreenRequired: false,
        coldIschemiaLimit_min: 720,            // 12h
        coldIschemiaRemainingThreshold_min: 30,
        infectionScreenRequired: ['HIV', 'HepB', 'HepC'],
        acceptsExtendedCriteria: true,
        pediatricAllowed: true,
        acceptsReceiverStatuses: ['waiting'],
        waitingTimeCapDays: 730,
        workflow: ['suggested', 'reserved', 'accepted', 'in_progress', 'completed'],
        // MELD drives liver allocation. The urgency factor is derived from the
        // receiver's MELD_score (+ any board MELD_ExceptionPoints) through a
        // piecewise curve, not the coarse Urgency enum.
        priorityOverride: 'MELD_score'
    };
}

function heartPolicy() {
    return {
        version: '2026.09.0',
        scoreWeights: {
            location: 0.20,
            urgency: 0.35,
            waitingTime: 0.15,
            ageProximity: 0.10,
            pediatricPriority: 0.10,
            sizeMatch: 0.05,
            hlaMatch: 0,
            coldIschemiaRemaining: 0.05
        },
        ageLimit: { min: 0, max: 65, idealMax: 55 },
        weightMatch: { tolerance_grams: 100 },
        // Hearts are age-sensitive: a large donor-receiver age gap is penalized
        // beyond the donor-age curve alone.
        ageMatch: { useAgeDifference: true, gapToleranceYears: 15 },
        HLA_matchRequired: false,
        crossmatchRequired: false,
        antibodyScreenRequired: false,
        coldIschemiaLimit_min: 240,            // 4h
        coldIschemiaRemainingThreshold_min: 30,
        infectionScreenRequired: ['HIV', 'HepB', 'HepC'],
        acceptsExtendedCriteria: false,
        pediatricAllowed: true,
        acceptsReceiverStatuses: ['waiting'],
        waitingTimeCapDays: 1095,
        workflow: ['suggested', 'reserved', 'accepted', 'in_progress', 'completed'],
        // Heart allocation runs on UNOS-style status tiers (receiver.HeartStatus
        // 1..6), not the coarse Urgency enum.
        priorityOverride: 'heart_status'
    };
}

function lungsPolicy() {
    return {
        version: '2026.09.0',
        scoreWeights: {
            location: 0.20,
            urgency: 0.30,
            waitingTime: 0.20,
            ageProximity: 0.10,
            pediatricPriority: 0,
            sizeMatch: 0.15,
            hlaMatch: 0,
            coldIschemiaRemaining: 0.05
        },
        ageLimit: { min: 0, max: 70, idealMax: 60 },
        weightMatch: { tolerance_grams: 150 },
        ageMatch: { useAgeDifference: true, gapToleranceYears: 20 },
        HLA_matchRequired: false,
        crossmatchRequired: false,
        coldIschemiaLimit_min: 360,            // 6h
        coldIschemiaRemainingThreshold_min: 30,
        infectionScreenRequired: ['HIV', 'HepB', 'HepC'],
        acceptsExtendedCriteria: false,
        pediatricAllowed: false,
        acceptsReceiverStatuses: ['waiting'],
        waitingTimeCapDays: 1095,
        workflow: ['suggested', 'reserved', 'accepted', 'in_progress', 'completed']
    };
}

function corneaPolicy() {
    return {
        version: '2026.09.0',
        scoreWeights: {
            location: 0.30,
            urgency: 0,                        // elective graft — urgency is meaningless
            waitingTime: 0.50,
            ageProximity: 0.10,
            pediatricPriority: 0.10,
            sizeMatch: 0,
            hlaMatch: 0,
            coldIschemiaRemaining: 0
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
        waitingTimeCapDays: 1825,
        workflow: ['suggested', 'reserved', 'accepted', 'in_progress', 'completed']
    };
}

function boneMarrowPolicy() {
    return {
        version: '2026.09.0',
        scoreWeights: {
            location: 0.10,
            urgency: 0.15,
            waitingTime: 0.10,
            ageProximity: 0.05,
            pediatricPriority: 0.10,
            sizeMatch: 0,
            hlaMatch: 0.50,
            coldIschemiaRemaining: 0
        },
        ageLimit: { min: 0, max: 80, idealMax: 60 },
        // Marrow is the strictest HLA gate: a full 6/6 weighted match scores
        // 100 (DR most important, then B, then A); minHlaScore 100 preserves
        // the old "6 antigen matches" rule under weighted diploid scoring.
        HLA_matchRequired: { minHlaScore: 100, loci: ['A', 'B', 'DR'], locusWeights: { A: 0.2, B: 0.3, DR: 0.5 } },
        crossmatchRequired: true,
        // ABO is deliberately NOT required for marrow: a marrow graft's
        // lymphocytes are replaced by the recipient's within weeks, so ABO
        // incompatibility is survivable and marrow is allocated on HLA alone.
        // Setting this bypasses the ABO-ok gate in eligibility; every other
        // organ in this registry keeps its ABO requirement.
        ignoreABO: true,
        coldIschemiaLimit_min: 0,              // not applicable
        coldIschemiaRemainingThreshold_min: 0,
        infectionScreenRequired: ['HIV', 'HepB', 'HepC', 'CMV', 'EBV'],
        acceptsExtendedCriteria: false,
        pediatricAllowed: true,
        acceptsReceiverStatuses: ['waiting'],
        waitingTimeCapDays: 730,
        workflow: ['suggested', 'reserved', 'crossmatch_confirmed', 'accepted', 'in_progress', 'completed']
    };
}

function skinPolicy() {
    return {
        version: '2026.09.0',
        scoreWeights: {
            location: 0.35,
            urgency: 0,                        // elective graft
            waitingTime: 0.45,
            ageProximity: 0.10,
            pediatricPriority: 0.10,
            sizeMatch: 0,
            hlaMatch: 0,
            coldIschemiaRemaining: 0
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
        waitingTimeCapDays: 1460,
        workflow: ['suggested', 'reserved', 'accepted', 'in_progress', 'completed']
    };
}

function pancreasPolicy() {
    return {
        version: '2026.09.0',
        scoreWeights: {
            location: 0.20,
            urgency: 0.30,
            waitingTime: 0.20,
            ageProximity: 0.10,
            pediatricPriority: 0,
            sizeMatch: 0.10,
            hlaMatch: 0.05,
            coldIschemiaRemaining: 0.05
        },
        ageLimit: { min: 0, max: 60, idealMax: 50 },
        weightMatch: { tolerance_grams: 100 },
        HLA_matchRequired: false,
        crossmatchRequired: false,
        antibodyScreenRequired: false,
        coldIschemiaLimit_min: 720,            // 12h
        coldIschemiaRemainingThreshold_min: 30,
        infectionScreenRequired: ['HIV', 'HepB', 'HepC', 'CMV', 'EBV'],
        acceptsExtendedCriteria: false,
        pediatricAllowed: false,
        acceptsReceiverStatuses: ['waiting'],
        waitingTimeCapDays: 730,
        workflow: ['suggested', 'reserved', 'accepted', 'in_progress', 'completed']
    };
}

function smallIntestinePolicy() {
    return {
        version: '2026.09.0',
        scoreWeights: {
            location: 0.20,
            urgency: 0.30,
            waitingTime: 0.15,
            ageProximity: 0.10,
            pediatricPriority: 0.10,
            sizeMatch: 0.10,
            hlaMatch: 0,
            coldIschemiaRemaining: 0.05
        },
        ageLimit: { min: 0, max: 60, idealMax: 50 },
        weightMatch: { tolerance_grams: 300 },
        HLA_matchRequired: false,
        crossmatchRequired: false,
        antibodyScreenRequired: false,
        coldIschemiaLimit_min: 360,            // 6h — very ischemia-sensitive
        coldIschemiaRemainingThreshold_min: 30,
        infectionScreenRequired: ['HIV', 'HepB', 'HepC', 'CMV', 'EBV'],
        acceptsExtendedCriteria: false,
        pediatricAllowed: true,
        acceptsReceiverStatuses: ['waiting'],
        waitingTimeCapDays: 730,
        workflow: ['suggested', 'reserved', 'accepted', 'in_progress', 'completed']
    };
}

function bonePolicy() {
    return {
        version: '2026.09.0',
        scoreWeights: {
            location: 0.35,
            urgency: 0,                        // elective graft
            waitingTime: 0.45,
            ageProximity: 0.10,
            pediatricPriority: 0.10,
            sizeMatch: 0,
            hlaMatch: 0,
            coldIschemiaRemaining: 0
        },
        ageLimit: { min: 0, max: 90, idealMax: 70 },
        HLA_matchRequired: false,
        crossmatchRequired: false,
        coldIschemiaLimit_min: 10080,          // 7 days — bone tissue stores well
        coldIschemiaRemainingThreshold_min: 60,
        infectionScreenRequired: ['HIV', 'HepB', 'HepC', 'Syphilis'],
        acceptsExtendedCriteria: true,
        pediatricAllowed: true,
        acceptsReceiverStatuses: ['verified', 'waiting'],
        waitingTimeCapDays: 1825,
        workflow: ['suggested', 'reserved', 'accepted', 'in_progress', 'completed']
    };
}

function heartValvePolicy() {
    return {
        version: '2026.09.0',
        scoreWeights: {
            location: 0.35,
            urgency: 0,                        // elective graft
            waitingTime: 0.45,
            ageProximity: 0.10,
            pediatricPriority: 0.10,
            sizeMatch: 0,
            hlaMatch: 0,
            coldIschemiaRemaining: 0
        },
        ageLimit: { min: 0, max: 90, idealMax: 65 },
        HLA_matchRequired: false,
        crossmatchRequired: false,
        coldIschemiaLimit_min: 20160,          // 14 days — cryopreserved valves
        coldIschemiaRemainingThreshold_min: 60,
        infectionScreenRequired: ['HIV', 'HepB', 'HepC', 'Syphilis'],
        acceptsExtendedCriteria: true,
        pediatricAllowed: true,
        acceptsReceiverStatuses: ['verified', 'waiting'],
        waitingTimeCapDays: 1825,
        workflow: ['suggested', 'reserved', 'accepted', 'in_progress', 'completed']
    };
}

const POLICIES = {
    Kidney: kidneyPolicy,
    Liver: liverPolicy,
    Heart: heartPolicy,
    Lungs: lungsPolicy,
    Pancreas: pancreasPolicy,
    'Small Intestine': smallIntestinePolicy,
    Cornea: corneaPolicy,
    Skin: skinPolicy,
    Bone: bonePolicy,
    'Bone Marrow': boneMarrowPolicy,
    'Heart Valve': heartValvePolicy
};

function normalizeOrganName(organName) {
    if (typeof organName !== 'string') return organName;
    const trimmed = organName.trim();
    if (!trimmed) return trimmed;

    const collapsed = trimmed.replace(/[-_\s]+/g, ' ').toLowerCase();
    const aliases = {
        kidney: 'Kidney',
        liver: 'Liver',
        heart: 'Heart',
        lungs: 'Lungs',
        pancreas: 'Pancreas',
        'small intestine': 'Small Intestine',
        'small intestines': 'Small Intestine',
        cornea: 'Cornea',
        skin: 'Skin',
        bone: 'Bone',
        'bone marrow': 'Bone Marrow',
        'bone-marrow': 'Bone Marrow',
        'heart valve': 'Heart Valve',
        'heart-valve': 'Heart Valve'
    };

    return aliases[collapsed] || trimmed;
}

// Returns the policy for an organ name. Throws AppError(400) for any organ
// the registry doesn't know about — better to fail loud at match time than
// silently apply the wrong rules.
function getOrganPolicy(organName) {
    const canonicalName = normalizeOrganName(organName);
    const factory = POLICIES[canonicalName];
    if (!factory) {
        throw new AppError(`unknown organ: ${organName}`, 400);
    }
    return factory();
}

module.exports = { getOrganPolicy, POLICIES, normalizeOrganName };
