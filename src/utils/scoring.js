const logger = require('./logger');
const { locationScore } = require('./matching');

// Maps the receiver's Urgency enum to a 0..100 score. Mirrors the ordering
// in src/services/receiver.service.js (critical < urgent < stable), but on a
// 0..100 scale so it composes with the other factors.
const URGENCY_SCORES = { critical: 100, urgent: 66, stable: 33 };

// Counts how many HLA antigens the donor and receiver share on the listed loci.
// Returns null if either side has no typing recorded — caller treats that as
// "not applicable" rather than "0% match".
function hlaOverlap(donor, receiver, loci) {
    if (!donor || !receiver || !loci || loci.length === 0) return null;
    let matches = 0;
    let total = 0;
    for (const locus of loci) {
        const d = (donor.HLA_Typing && donor.HLA_Typing[locus]) || [];
        const r = (receiver.HLA_Typing && receiver.HLA_Typing[locus]) || [];
        if (d.length === 0 || r.length === 0) return null;       // missing typing → not applicable
        for (const antigen of d) {
            if (r.includes(antigen)) matches += 1;
            total += 1;
        }
    }
    return total === 0 ? null : Math.round((matches / total) * 100);
}

// Days since the receiver joined the waitlist. Negative values (clock skew)
// clamp to 0.
function daysWaiting(receiver, now) {
    if (!receiver.WaitlistDate) return 0;
    const ms = now.getTime() - new Date(receiver.WaitlistDate).getTime();
    return Math.max(0, Math.floor(ms / (1000 * 60 * 60 * 24)));
}

// Score 0..100 for how close the donor age is to the policy's idealMax.
// Inside the ideal range this is 100; outside it decays linearly to 0 at
// `policy.ageLimit.max`.
function ageProximityScore(donor, policy) {
    const max = policy.ageLimit && policy.ageLimit.max;
    const ideal = policy.ageLimit && policy.ageLimit.idealMax;
    if (!max) return 0;
    if (donor.Age <= ideal) return 100;
    if (donor.Age >= max) return 0;
    return Math.round(((max - donor.Age) / (max - ideal)) * 100);
}

// 0..100 — does the donor organ weight fit the receiver's accepted range?
// If either side is missing, returns null (organ-specific — e.g. cornea).
function sizeMatchScore(donor, organEntry, receiver) {
    if (!organEntry || organEntry.OrganWeight_grams == null) return null;
    if (receiver.MinOrganWeight_grams == null || receiver.MaxOrganWeight_grams == null) return null;
    const w = organEntry.OrganWeight_grams;
    if (w >= receiver.MinOrganWeight_grams && w <= receiver.MaxOrganWeight_grams) return 100;
    return 0;
}

// 0..100 — how much of the cold-ischemia budget is left? 100 = untouched,
// 0 = at the threshold, below = negative (caller treats as ineligible).
function coldIschemiaRemainingScore(organEntry, policy, now) {
    const limit = policy.coldIschemiaLimit_min || 0;
    if (limit === 0) return 100;            // not applicable (e.g. marrow)
    if (!organEntry.IschemiaStartedAt) return 100;
    const elapsed = (now.getTime() - new Date(organEntry.IschemiaStartedAt).getTime()) / 60000;
    const remaining = Math.max(0, limit - elapsed);
    return Math.round((remaining / limit) * 100);
}

// 0..100 — translate locationScore (0=same district, 1=same state, 2=other)
// into a comparable score. Same district is best; cross-state is worst.
function locationScore100(locationScore) {
    if (locationScore === 0) return 100;
    if (locationScore === 1) return 60;
    return 20;
}

// Maps locationScore to an implied distance band. Not a true distance —
// locationScore has only three buckets — but gives the UI something to show.
function distanceBand(locationScore) {
    if (locationScore === 0) return 'local';
    if (locationScore === 1) return 'state';
    return 'national';
}

// Returns { total, breakdown } for a single donor-organ/receiver pair.
// `total` is 0..100 — the sum of factor * weight, renormalized so the sum of
// weights equals 1 even when some factors are null (e.g. HLA on liver).
function scoreMatch(donor, organEntry, receiver, organNeeded, policy, now) {
    const factors = {
        locationScore: locationScore(donor, receiver),
        distanceBand: distanceBand(locationScore(donor, receiver)),
        donorAge: donor.Age,
        receiverAge: receiver.Age,
        daysWaiting: daysWaiting(receiver, now),
        urgencyScore: URGENCY_SCORES[receiver.Urgency] ?? 0,
        hlaMatches: null,
        hlaTotal: null
    };

    const sub = {
        location: locationScore100(factors.locationScore),
        urgency: factors.urgencyScore,
        waitingTime: Math.min(100, Math.round((factors.daysWaiting / 365) * 100)),    // 1y wait → 100
        ageProximity: ageProximityScore(donor, policy),
        sizeMatch: sizeMatchScore(donor, organEntry, receiver),
        hlaMatch: null,
        coldIschemiaRemaining: coldIschemiaRemainingScore(organEntry, policy, now)
    };

    // HLA is organ-specific; only score when the policy asks for it AND both
    // sides have typing. Otherwise leave the factor null and let the weight
    // table renormalize.
    if (policy.HLA_matchRequired && policy.HLA_matchRequired.loci) {
        const overlap = hlaOverlap(donor, receiver, policy.HLA_matchRequired.loci);
        if (overlap !== null) {
            sub.hlaMatch = overlap;
            factors.hlaMatches = overlap;     // already a percentage, but keep raw too if needed
        }
    }

    // Renormalize: drop null factors from the denominator so the remaining
    // factors still sum to 100 in their weighted sum.
    const w = policy.scoreWeights;
    const activeFactors = Object.entries(sub).filter(([k]) => {
        if (k === 'hlaMatch' && sub.hlaMatch === null) return false;
        return true;
    });
    const weightSum = activeFactors.reduce((acc, [k]) => acc + (w[k] || 0), 0) || 1;
    const total = Math.round(
        activeFactors.reduce((acc, [k, v]) => acc + (v * (w[k] || 0)) / weightSum, 0)
    );

    const breakdown = {
        ...sub,
        policyVersion: policy.version,
        weights: w,
        factors
    };

    if (process.env.SCORING_DEBUG === '1') {
        logger.debug({ donorId: donor._id, receiverId: receiver._id, total, breakdown }, 'scoring detail');
    }

    return { total, breakdown };
}

module.exports = { scoreMatch, URGENCY_SCORES, hlaOverlap };