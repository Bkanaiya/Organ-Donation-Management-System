const AppError = require('../utils/AppError');
const Crossmatch = require('../models/crossmatch.model');
const { getCompatibleDonorBloodGroups } = require('../utils/matching');
const { hlaCompatibility, normalizeHLA } = require('../utils/scoring');

// Read each infection marker from the donor organ subdoc (donor.OrgansDonated[].
// InfectionScreening). The schema treats absent markers as "not screened"
// rather than "negative" — failing closed.
function getInfectionScreen(organEntry) {
    return (organEntry && organEntry.InfectionScreening) || {};
}

// Returns true when the policy requires every listed pathogen to be present
// AND marked negative. If the policy lists nothing, screening passes by
// default.
function passesInfectionScreen(organEntry, policy) {
    const required = policy.infectionScreenRequired || [];
    if (required.length === 0) return { ok: true };
    const screen = getInfectionScreen(organEntry);
    for (const marker of required) {
        const v = screen[marker];
        if (v === true) return { ok: false, reason: `infection screen positive: ${marker}` };
        if (v !== false) return { ok: false, reason: `infection screen missing: ${marker}` };
    }
    return { ok: true };
}

// HLA overlap: minimum weighted compatibility the policy requires. Uses the
// SAME weighted, diploid-normalized metric as scoring's hlaMatch factor (see
// hlaCompatibility in utils/scoring.js) so eligibility and ranking can't
// disagree — the old code compared a raw minMatches count against a
// percentage in the score, two inconsistent views of the same pair. Returns
// {ok: true} when the policy doesn't require HLA, {ok: false, reason}
// otherwise.
function passesHLA(donor, organEntry, receiver, policy) {
    const cfg = policy.HLA_matchRequired;
    if (!cfg) return { ok: true };
    const minScore = cfg.minHlaScore != null ? cfg.minHlaScore : 0;
    if (minScore === 0) return { ok: true };
    const compat = hlaCompatibility(donor, organEntry, receiver, cfg);
    if (!compat) {
        return { ok: false, reason: 'HLA typing missing on donor or receiver' };
    }
    if (compat.score < minScore) {
        return { ok: false, reason: `HLA compatibility ${compat.score} below required ${minScore}` };
    }
    return { ok: true, ...compat };
}

// Age check against the policy's ageLimit range.
function passesAgeLimit(donor, policy) {
    const lim = policy.ageLimit;
    if (!lim) return { ok: true };
    if (donor.Age < lim.min) return { ok: false, reason: `donor age ${donor.Age} below minimum ${lim.min}` };
    if (donor.Age > lim.max) return { ok: false, reason: `donor age ${donor.Age} above maximum ${lim.max}` };
    return { ok: true };
}

// Antibody-sensitization gate — used by kidney. The lab crossmatch is
// pair-specific and runs AFTER a match is reserved (see recordCrossmatch in
// match.service.js), so at allocation time we gate on the *virtual*
// crossmatch instead: the receiver must have a recorded antibody screen
// (cPRA) and none of their UnacceptableAntigens may appear on the donor.
// A donor cPRA would be meaningless here — it's a receiver-side measure.
// Antigen strings are compared in normalized form (A1 == A01, DRB1*01:01 ==
// DRB1*0101) so a naming variant can't hide a real sensitization clash.
function passesAntibodyScreen(donor, organEntry, receiver, policy) {
    if (!policy.antibodyScreenRequired) return { ok: true };
    if (receiver.cPRA == null) return { ok: false, reason: 'receiver antibody screen not recorded' };
    const unacceptable = receiver.UnacceptableAntigens;
    if (!Array.isArray(unacceptable) || unacceptable.length === 0) {
        // Screen done, no known unacceptable antigens — nothing to screen
        // against, so the pair passes.
        return { ok: true };
    }
    const donorHLA = (organEntry && organEntry.HLA_Typing) || donor.HLA_Typing;
    if (!donorHLA) {
        return { ok: false, reason: 'donor HLA typing not recorded' };
    }
    const donorAntigens = new Set([
        ...(donorHLA.A || []),
        ...(donorHLA.B || []),
        ...(donorHLA.DR || [])
    ].map(normalizeHLA));
    const clash = unacceptable.map(normalizeHLA).find((a) => a && donorAntigens.has(a));
    if (clash) {
        return { ok: false, reason: `virtual crossmatch positive: donor carries unacceptable antigen ${clash}` };
    }
    return { ok: true };
}

// Cold-ischemia budget. If the policy has no limit (e.g. marrow), pass.
function passesColdIschemia(organEntry, policy, now) {
    const limit = policy.coldIschemiaLimit_min;
    const threshold = policy.coldIschemiaRemainingThreshold_min || 0;
    if (!limit) return { ok: true };
    if (!organEntry.IschemiaStartedAt) return { ok: true };   // not yet procured
    const elapsed = (now.getTime() - new Date(organEntry.IschemiaStartedAt).getTime()) / 60000;
    const remaining = limit - elapsed;
    if (remaining < threshold) {
        return { ok: false, reason: `cold ischemia below threshold (${Math.round(remaining)} min remaining, need ${threshold})` };
    }
    return { ok: true, remainingMinutes: Math.round(remaining) };
}

// Pediatric policy flag — pediatric organs require an accepting receiver.
function passesPediatric(organEntry, receiver, policy) {
    if (!policy.pediatricAllowed) return { ok: true };
    if (organEntry.IsPediatric && !receiver.AcceptsPediatricOrgan) {
        return { ok: false, reason: 'receiver does not accept pediatric organs' };
    }
    return { ok: true };
}

// Extended-criteria organs (e.g. older donor, biopsy-threshold, marginal
// quality) are only allocated to a receiver who has explicitly opted in via
// `AcceptsExtendedCriteria`. The policy must also opt in via
// `acceptsExtendedCriteria` for this rule to apply — cornea/skin accept
// extended criteria broadly, but bone-marrow does not. When the policy
// doesn't opt in, every donor organ is treated as standard.
function passesExtendedCriteria(organEntry, receiver, policy) {
    if (!policy.acceptsExtendedCriteria) return { ok: true };
    const isExtended = organEntry.OrganQuality && organEntry.OrganQuality !== 'ideal';
    if (isExtended && !receiver.AcceptsExtendedCriteria) {
        return { ok: false, reason: `extended-criteria organ (${organEntry.OrganQuality}) requires receiver to accept extended criteria` };
    }
    return { ok: true };
}

// Size match. Two layers, in priority order:
//   1. If the receiver recorded a Min/MaxOrganWeight_grams range, the donor
//      organ weight must fall inside it (this is a hard eligibility rule —
//      a 400 g organ in a 50 kg child is never acceptable).
//   2. If the receiver recorded no range but the policy declares a weight
//      tolerance (kidney, liver, heart, lungs, pancreas, small intestine),
//      we FAIL CLOSED: size compatibility cannot be verified, so the pair is
//      rejected until the coordinator records the receiver's size range.
//      Accepting any weighed organ here is the "clearly unsuitable organ
//      passes eligibility" hole — a policy-declared tolerance means the
//      organ is size-sensitive, and a receiver without recorded size
//      preferences is not a safe candidate for it.
//
// Either way: when a policy declares a weight tolerance, the donor MUST have
// recorded OrganWeight_grams — silently allowing unrecorded weights past
// the size gate would defeat the whole point of declaring a tolerance.
function passesWeightMatch(organEntry, receiver, policy) {
    const tolerance = policy.weightMatch && policy.weightMatch.tolerance_grams;
    const rMin = receiver.MinOrganWeight_grams;
    const rMax = receiver.MaxOrganWeight_grams;
    if (rMin != null || rMax != null) {
        if (organEntry.OrganWeight_grams == null) {
            return { ok: false, reason: 'donor organ weight not recorded' };
        }
        const w = organEntry.OrganWeight_grams;
        if (rMin != null && w < rMin) {
            return { ok: false, reason: `organ weight ${w}g below receiver minimum ${rMin}g` };
        }
        if (rMax != null && w > rMax) {
            return { ok: false, reason: `organ weight ${w}g above receiver maximum ${rMax}g` };
        }
        return { ok: true };
    }
    if (tolerance != null) {
        // Weight-sensitive organ but the receiver never recorded a size
        // preference — fail closed rather than accepting any weighed organ.
        return { ok: false, reason: 'receiver size preference not recorded' };
    }
    return { ok: true };
}

// ABO compatibility. The blood-compat table is donor→receiver; the helper
// returns the set of donor blood types that can give to this receiver.
function passesABO(donor, receiver) {
    const compatible = getCompatibleDonorBloodGroups(receiver.BloodGroup);
    if (!compatible.includes(donor.BloodGroup)) {
        return { ok: false, reason: `ABO incompatible: donor ${donor.BloodGroup} cannot donate to receiver ${receiver.BloodGroup}` };
    }
    return { ok: true };
}

// Runs every clinical rule. Throws AppError(409) on the first failure so the
// service can surface a single, actionable error to the caller. Each rule is
// also recorded in `flags` for the suggest-side evaluation.
function runChecks(donor, organEntry, receiver, organNeeded, policy, now) {
    const flags = {};
    const reasons = [];

    if (!donor.IsVerified)            { reasons.push('donor not verified'); }
    if (!donor.ConsentGiven)          { reasons.push('donor consent missing'); }
    if (!['available', 'verified'].includes(donor.Status)) {
        reasons.push(`donor status ${donor.Status} not allocatable`);
    }
    // The organ itself can be harvested (proceed to surgery) but individually
    // withdrawn by the donor's family or routed to research — a withdrawn or
    // 'no longer available' organ must not be allocated even when the donor
    // doc looks allocatable. Default 'available' keeps legacy records honest.
    const organStatus = (organEntry && organEntry.Status) || 'available';
    if (!['available', 'verified'].includes(organStatus)) {
        reasons.push(`organ status ${organStatus} not allocatable`);
    }
    flags.verifiedOk = donor.IsVerified === true;
    flags.consentOk = donor.ConsentGiven === true;
    flags.donorStatusOk = ['available', 'verified'].includes(donor.Status);
    flags.organStatusOk = ['available', 'verified'].includes(organStatus);

    if (!receiver.IsVerified)         { reasons.push('receiver not verified'); }
    if (!policy.acceptsReceiverStatuses.includes(receiver.Status)) {
        reasons.push(`receiver status ${receiver.Status} not in [${policy.acceptsReceiverStatuses.join(', ')}]`);
    }
    flags.receiverVerifiedOk = receiver.IsVerified === true;
    flags.receiverStatusOk = policy.acceptsReceiverStatuses.includes(receiver.Status);

    if (receiver.Organ_needed !== organNeeded) {
        reasons.push(`receiver needs ${receiver.Organ_needed}, requested ${organNeeded}`);
    }
    flags.organMatchOk = receiver.Organ_needed === organNeeded;

    const abo = policy.ignoreABO ? { ok: true } : passesABO(donor, receiver);
    flags.aboOk = abo.ok;
    if (!abo.ok) reasons.push(abo.reason);

    const age = passesAgeLimit(donor, policy);
    flags.ageOk = age.ok;
    if (!age.ok) reasons.push(age.reason);

    const inf = passesInfectionScreen(organEntry, policy);
    flags.infectionOk = inf.ok;
    if (!inf.ok) reasons.push(inf.reason);

    // NOTE: no lab-crossmatch gate here. A crossmatch is donor-recipient-
    // pair-specific and is confirmed AFTER a match is reserved (see
    // recordCrossmatch in match.service.js) — gating it at allocation time
    // would reuse one pair's result for every receiver, which is exactly the
    // bug the Crossmatch model fixes. What gates here is the virtual
    // crossmatch: the receiver's recorded UnacceptableAntigens vs the donor's
    // HLA typing.
    const hla = passesHLA(donor, organEntry, receiver, policy);
    flags.hlaOk = hla.ok;
    if (!hla.ok) reasons.push(hla.reason);

    const ab = passesAntibodyScreen(donor, organEntry, receiver, policy);
    flags.antibodyScreenOk = ab.ok;
    if (!ab.ok) reasons.push(ab.reason);

    const cold = passesColdIschemia(organEntry, policy, now);
    flags.coldIschemiaOk = cold.ok;
    if (!cold.ok) reasons.push(cold.reason);

    const ped = passesPediatric(organEntry, receiver, policy);
    flags.pediatricOk = ped.ok;
    if (!ped.ok) reasons.push(ped.reason);

    const ext = passesExtendedCriteria(organEntry, receiver, policy);
    flags.extendedCriteriaOk = ext.ok;
    if (!ext.ok) reasons.push(ext.reason);

    const wm = passesWeightMatch(organEntry, receiver, policy);
    flags.weightMatchOk = wm.ok;
    if (!wm.ok) reasons.push(wm.reason);

    return { eligible: reasons.length === 0, reasons, flags };
}

// Used by createMatch. Throws AppError on the first failure.
function assertDonorOrganAllocatable(donor, organEntry, receiver, organNeeded, policy, now = new Date()) {
    const result = runChecks(donor, organEntry, receiver, organNeeded, policy, now);
    if (!result.eligible) {
        throw new AppError(result.reasons.join('; '), 409);
    }
}

// Used by suggest — never throws, always returns {eligible, reasons, flags}.
function evaluateDonorOrganForReceiver(donor, organEntry, receiver, organNeeded, policy, now = new Date()) {
    return runChecks(donor, organEntry, receiver, organNeeded, policy, now);
}

module.exports = {
    assertDonorOrganAllocatable,
    evaluateDonorOrganForReceiver
};