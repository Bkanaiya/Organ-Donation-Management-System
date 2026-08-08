const logger = require('./logger');
const { distanceKmBetween } = require('./matching');

// Maps the receiver's Urgency enum to a 0..100 score. Mirrors the ordering
// in src/services/receiver.service.js (critical < urgent < stable), but on a
// 0..100 scale so it composes with the other factors. This is the fallback
// for policies without a medical-priority override.
const URGENCY_SCORES = { critical: 100, urgent: 66, stable: 33 };

// UNOS-style adult heart allocation tiers (1 = most urgent). Used by the
// heart policy via priorityOverride: 'heart_status' — the coarse Urgency
// enum is clinically meaningless for heart allocation, where status tiers
// drive who gets the organ.
const HEART_STATUS_SCORES = { 1: 100, 2: 85, 3: 70, 4: 55, 5: 40, 6: 25 };

// Default HLA locus weights. DR is the most clinically significant locus for
// solid-organ and marrow matching; B carries less weight, A least.
const DEFAULT_HLA_WEIGHTS = { A: 0.2, B: 0.3, DR: 0.5 };

// Receivers below this age get a pediatric-priority boost.
const PEDIATRIC_AGE = 18;

// ---------------------------------------------------------------------------
// HLA helpers
// ---------------------------------------------------------------------------

// Normalizes an HLA antigen string so naming variants compare equal.
//   - strips whitespace and separators (* : - _ .)
//   - uppercases
//   - zero-pads a single-digit allele number (A1 -> A01, B7 -> B07,
//     DR1 -> DR01) so serology-style typing matches the padded lab format.
// 'DRB1*01:01' and 'DRB1*0101' both collapse to 'DRB10101' and compare equal.
// Used by BOTH the eligibility engine's virtual crossmatch and the scoring
// hlaMatch factor, so a clash can't slip through on string formatting.
function normalizeHLA(antigen) {
    if (typeof antigen !== 'string') return '';
    const cleaned = antigen.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    const m = cleaned.match(/^([A-Z]+)(\d)$/);
    if (m) return `${m[1]}0${m[2]}`;
    return cleaned;
}

// Weighted HLA compatibility for a donor-organ / receiver pair. Returns
// { score: 0..100, matches, expected, perLocus } or null when the policy asks
// for a locus that either side hasn't typed (caller treats null as "not
// applicable" rather than "0% match").
//
// The per-locus fraction is matched alleles / 2 — the diploid genotype size —
// NOT matched / typed-alleles. Sparse typing can't inflate the result: a
// donor typed with a single allele that happens to match scores 50% for that
// locus, not 100%. Locus weights (DR > B > A) then combine the fractions, so
// a DR match moves the needle more than an A match.
function hlaCompatibility(donor, organEntry, receiver, cfg) {
    if (!cfg || !cfg.loci || cfg.loci.length === 0) return null;
    const donorHLA = (organEntry && organEntry.HLA_Typing) || donor.HLA_Typing;
    const receiverHLA = receiver.HLA_Typing;
    if (!donorHLA || !receiverHLA) return null;

    const loci = cfg.loci;
    const rawWeights = cfg.locusWeights || DEFAULT_HLA_WEIGHTS;
    const weights = {};
    let weightSum = 0;
    for (const locus of loci) {
        const w = rawWeights[locus];
        if (w != null && w > 0) {
            weights[locus] = w;
            weightSum += w;
        }
    }
    if (weightSum === 0) return null;

    const perLocus = {};
    let matches = 0;
    let expected = 0;
    let score = 0;
    for (const locus of loci) {
        const w = weights[locus];
        if (!w) continue;
        const dAlleles = (donorHLA[locus] || []).map(normalizeHLA);
        const rAlleles = (receiverHLA[locus] || []).map(normalizeHLA);
        if (dAlleles.length === 0 || rAlleles.length === 0) return null;  // untyped locus -> not applicable
        // Count DISTINCT donor alleles only. A homozygous typing (A1,A1) has
        // one antigen to give, not two — counting the duplicate would let a
        // homozygous donor sharing one allele per locus pass a 6/6 gate on
        // three real matches (the sparse-typing inflation bug, reapplied to
        // duplicates). Receiver-side duplicates are harmless because the
        // donor is the side being counted.
        const distinctDonor = [...new Set(dAlleles)];
        const rSet = new Set(rAlleles);
        const locusMatches = distinctDonor.filter((a) => rSet.has(a)).length;
        // The denominator is the donor's distinct typed alleles for this
        // locus (max 2) — NOT a fixed 2. A fixed 2 made a confirmed
        // homozygous donor (A1,A1) matched on A1 a permanent 50% on that
        // locus, so a homozygote could never clear marrow's minHlaScore 100
        // even with a perfect match. The 6/6 gate is about the antigens the
        // donor actually carries: a homozygote matched on its one allele IS
        // fully matched there. Heterozygous/sparse donors still score
        // matched/2 and can never get credit for an allele they weren't
        // typed with.
        const capacity = Math.min(2, distinctDonor.length);
        const fraction = capacity > 0 ? Math.min(1, locusMatches / capacity) : 0;
        perLocus[locus] = Math.round(fraction * 100);
        matches += locusMatches;
        expected += capacity;
        score += w * fraction;
    }
    return {
        score: Math.round((score / weightSum) * 100),
        matches,
        expected,
        perLocus
    };
}

// ---------------------------------------------------------------------------
// Waiting time
// ---------------------------------------------------------------------------

// Days since the receiver joined the waitlist. Negative values (clock skew)
// clamp to 0. WaitlistDate is stamped server-side at waitlist entry — when the
// receiver is created with Status 'waiting' (see receiver.service.js) — so it
// can't be backdated to inflate this factor.
function daysWaiting(receiver, now) {
    if (!receiver.WaitlistDate) return 0;
    const ms = now.getTime() - new Date(receiver.WaitlistDate).getTime();
    return Math.max(0, Math.floor(ms / (1000 * 60 * 60 * 24)));
}

// 0..100 — waiting time normalized against the policy's cap. The cap keeps
// the factor comparable across organs (kidney 1095d, liver 730d) and stops
// long waits from all saturating at 100.
function waitingTimeScore(days, policy) {
    const capDays = policy.waitingTimeCapDays || 365;
    return Math.min(100, Math.round((days / capDays) * 100));
}

// ---------------------------------------------------------------------------
// Medical urgency — organ-specific
// ---------------------------------------------------------------------------

// 0..100 — MELD-driven liver urgency. The raw MELD (6..40) plus any board
// exception points is mapped through a piecewise scale that is flatter in the
// low range and steeper at the top, where each MELD point is clinically much
// more costly. Exception points are added BEFORE the mapping (capped at 40)
// and are the liver counterpart of UNOS MELD exception scoring.
function meldUrgencyScore(receiver) {
    const base = receiver.MELD_score != null ? receiver.MELD_score : 0;
    const exception = receiver.MELD_ExceptionPoints != null ? receiver.MELD_ExceptionPoints : 0;
    const effective = Math.min(40, base + exception);
    if (effective <= 20) return Math.round((effective / 20) * 50);           // 0..50
    if (effective <= 30) return Math.round(50 + ((effective - 20) / 10) * 25); // 50..75
    return Math.round(75 + ((effective - 30) / 10) * 25);                      // 75..100
}

// 0..100 — heart status tiers (1..6). Pure tier lookup — the caller
// (urgencyScore) decides what to do when the receiver has no tier.
function heartUrgencyScore(receiver) {
    return receiver.HeartStatus != null ? (HEART_STATUS_SCORES[receiver.HeartStatus] ?? 0) : 0;
}

// 0..100 — medical urgency. The policy's priorityOverride selects the
// clinically meaningful scale, and that scale is AUTHORITATIVE — it is never
// traded down for the coarse critical/urgent/stable enum when the receiver
// lacks the clinical data. The enum means one thing on the generic list and
// something else entirely for a liver or heart patient, so comparing across
// receivers with and without data would rank by data completeness, not
// sickness. Missing clinical data fails closed to 0 (cannot substantiate
// urgency) — the same fail-closed posture eligibility uses for missing
// screens:
//   liver  -> MELD score (+ exception points), piecewise-mapped; 0 if no MELD
//   heart  -> UNOS status tier 1..6; 0 if no tier
//   (none) -> coarse critical/urgent/stable enum
function urgencyScore(receiver, policy) {
    if (policy.priorityOverride === 'MELD_score') {
        return receiver.MELD_score != null ? meldUrgencyScore(receiver) : 0;
    }
    if (policy.priorityOverride === 'heart_status') {
        return heartUrgencyScore(receiver);
    }
    return URGENCY_SCORES[receiver.Urgency] ?? 0;
}

// ---------------------------------------------------------------------------
// Location — smooth, organ-sensitive proximity
// ---------------------------------------------------------------------------

// The radius (km) at which proximity decays to ~37% (e^-1). Derived from the
// organ's cold-ischemia budget: a heart that must be transplanted within 4h
// has a small radius (distance matters a lot), a cornea stored for 5 days has
// a huge radius (distance barely matters). Assumes ~50 km/h effective
// transport speed, clamped to a sane band. A policy can pin an explicit
// `locationRadiusKm` to override the derivation.
function locationRadiusKm(policy) {
    if (policy.locationRadiusKm != null) return policy.locationRadiusKm;
    const limit = policy.coldIschemiaLimit_min;
    if (!limit) return 400;                              // no ischemia budget (marrow)
    return Math.min(1500, Math.max(60, Math.round((limit / 60) * 50)));
}

// 0..100 — exponential decay in estimated distance. Smooth (no cliff at the
// district border), and organ-specific because the decay radius scales with
// the ischemia budget. Same-district heart donor (~40km) scores 82 while a
// cross-state heart scores ~0; the same two cornea donors score 97 and 45.
function proximityScore(donor, receiver, policy) {
    const { distanceKm } = distanceKmBetween(donor, receiver);
    const radius = locationRadiusKm(policy);
    return Math.round(100 * Math.exp(-distanceKm / radius));
}

// Coarse band for display only — 'local' < 50km, 'state' < 400km, else
// 'national'. Mirrors the old locationScore buckets so the suggest payload's
// matchQuality stays backward compatible.
function distanceBand(distanceKm) {
    if (distanceKm < 50) return 'local';
    if (distanceKm < 400) return 'state';
    return 'national';
}

// ---------------------------------------------------------------------------
// Age — donor quality + donor/receiver age relationship
// ---------------------------------------------------------------------------

// 0..100 — combines two age curves:
//   1. donor-age curve against the policy's idealMax (unchanged semantics:
//      young/ideal-age donors score 100, decaying to 0 at ageLimit.max)
//   2. donor-receiver age relationship (critical for heart/lungs): a large
//      age gap is penalized beyond the policy's gapToleranceYears.
// Policies opt into the relationship via `ageMatch.useAgeDifference`; without
// it only the donor-age curve applies.
function ageProximityScore(donor, receiver, policy) {
    const max = policy.ageLimit && policy.ageLimit.max;
    const ideal = policy.ageLimit && policy.ageLimit.idealMax;
    let donorScore = 0;
    if (max) {
        if (donor.Age <= ideal) donorScore = 100;
        else if (donor.Age >= max) donorScore = 0;
        else donorScore = Math.round(((max - donor.Age) / (max - ideal)) * 100);
    }

    const ageMatchCfg = policy.ageMatch;
    if (!ageMatchCfg || !ageMatchCfg.useAgeDifference) return donorScore;

    const tolerance = ageMatchCfg.gapToleranceYears || 15;
    const gap = Math.abs(donor.Age - receiver.Age);
    let gapScore = 100;
    if (gap > tolerance) {
        // Full credit within the tolerance, linear decay to 0 at 2x tolerance.
        gapScore = Math.max(0, Math.round(100 - ((gap - tolerance) / tolerance) * 100));
    }
    return Math.round(donorScore * 0.5 + gapScore * 0.5);
}

// ---------------------------------------------------------------------------
// Pediatric priority
// ---------------------------------------------------------------------------

// 0..100 — pediatric receivers get priority on organs whose policy allows
// pediatric allocation. A pediatric organ matched to an adult (only possible
// when the receiver opted in via AcceptsPediatricOrgan) gets a partial boost
// so it isn't ranked identically to a standard organ. Adults with a standard
// organ score 0 — the factor only distinguishes candidates who deserve the
// boost, it never penalizes the rest beyond the weight it carries.
function pediatricPriorityScore(receiver, organEntry) {
    if (receiver.Age != null && receiver.Age < PEDIATRIC_AGE) return 100;
    if (organEntry && organEntry.IsPediatric) return 70;
    return 0;
}

// ---------------------------------------------------------------------------
// Size + ischemia — graded versions of eligibility gates
// ---------------------------------------------------------------------------

// 0..100 — how close the donor organ weight sits to the center of the
// receiver's accepted range. Eligibility guarantees the weight is INSIDE the
// range (or fails closed); this factor gives a gradient WITHIN it, so a
// weight at the range midpoint scores 100 and one at an edge scores 0. A
// pass/fail-only factor would give every eligible pair 100 and contribute
// zero ranking signal, which is what made the old version a dead factor.
// Returns null when size compatibility isn't applicable (no weightMatch
// tolerance, no organ weight, or no recorded receiver range).
function sizeMatchScore(organEntry, receiver, policy) {
    if (!policy.weightMatch) return null;
    if (!organEntry || organEntry.OrganWeight_grams == null) return null;
    const rMin = receiver.MinOrganWeight_grams;
    const rMax = receiver.MaxOrganWeight_grams;
    if (rMin == null || rMax == null) return null;
    const w = organEntry.OrganWeight_grams;
    const mid = (rMin + rMax) / 2;
    const halfWidth = Math.max(1, (rMax - rMin) / 2);
    const deviation = Math.abs(w - mid);
    return Math.max(0, Math.round(100 - (deviation / halfWidth) * 100));
}

// 0..100 — how much of the eligible cold-ischemia window is left. 100 = fresh
// (or not yet procured / no budget), 0 = at the eligibility threshold. The
// score is normalized against [threshold, limit] rather than [0, limit] so
// the factor is a gradient across the window that eligibility actually allows
// — organs close to expiry rank lower, and tissue organs with huge budgets
// don't all read as ~100.
function coldIschemiaRemainingScore(organEntry, policy, now) {
    const limit = policy.coldIschemiaLimit_min || 0;
    if (limit === 0) return 100;                        // not applicable (marrow)
    if (!organEntry || !organEntry.IschemiaStartedAt) return 100;
    const elapsed = (now.getTime() - new Date(organEntry.IschemiaStartedAt).getTime()) / 60000;
    const remaining = limit - elapsed;
    const threshold = policy.coldIschemiaRemainingThreshold_min || 0;
    if (remaining <= threshold) return 0;               // ineligible anyway
    return Math.round(((remaining - threshold) / (limit - threshold)) * 100);
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

// Returns { total, breakdown } for a single donor-organ/receiver pair.
// `total` is 0..100 — the sum of factor * weight, renormalized so the sum of
// weights equals 1 even when some factors are null (e.g. HLA on liver, or
// sizeMatch when the receiver has no recorded range).
function scoreMatch(donor, organEntry, receiver, organNeeded, policy, now) {
    const distance = distanceKmBetween(donor, receiver);
    const factors = {
        distanceKm: distance.distanceKm,
        distanceMethod: distance.method,
        distanceBand: distanceBand(distance.distanceKm),
        donorAge: donor.Age,
        receiverAge: receiver.Age,
        daysWaiting: daysWaiting(receiver, now),
        urgencyScore: urgencyScore(receiver, policy),
        urgencyLevel: receiver.Urgency,
        heartStatus: receiver.HeartStatus != null ? receiver.HeartStatus : null,
        meldScore: receiver.MELD_score != null ? receiver.MELD_score : null,
        meldExceptionPoints: receiver.MELD_ExceptionPoints != null ? receiver.MELD_ExceptionPoints : null,
        hlaMatches: null,
        hlaExpected: null
    };

    const sub = {
        location: proximityScore(donor, receiver, policy),
        urgency: urgencyScore(receiver, policy),
        waitingTime: waitingTimeScore(factors.daysWaiting, policy),
        ageProximity: ageProximityScore(donor, receiver, policy),
        pediatricPriority: pediatricPriorityScore(receiver, organEntry),
        sizeMatch: sizeMatchScore(organEntry, receiver, policy),
        hlaMatch: null,
        coldIschemiaRemaining: coldIschemiaRemainingScore(organEntry, policy, now)
    };

    // HLA is organ-specific; only score when the policy asks for it AND both
    // sides have typing on the required loci. Otherwise leave null and let the
    // weight table renormalize.
    if (policy.HLA_matchRequired && policy.HLA_matchRequired.loci && policy.HLA_matchRequired.loci.length > 0) {
        const compat = hlaCompatibility(donor, organEntry, receiver, policy.HLA_matchRequired);
        if (compat) {
            sub.hlaMatch = compat.score;
            factors.hlaMatches = compat.matches;
            factors.hlaExpected = compat.expected;
        }
    }

    // Renormalize: drop null factors from the denominator so the remaining
    // factors still sum to 100 in their weighted sum.
    const w = policy.scoreWeights;
    const activeFactors = Object.entries(sub).filter(([, v]) => v != null);
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

module.exports = {
    scoreMatch,
    URGENCY_SCORES,
    HEART_STATUS_SCORES,
    hlaCompatibility,
    normalizeHLA,
    proximityScore,
    meldUrgencyScore,
    ageProximityScore,
    coldIschemiaRemainingScore
};
