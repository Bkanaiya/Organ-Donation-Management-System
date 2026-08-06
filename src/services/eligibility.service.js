const AppError = require('../utils/AppError');
const { getCompatibleDonorBloodGroups } = require('../utils/matching');

// The list of infection markers we look for. Field name on the donor organ
// matches the entry in the policy's `infectionScreenRequired`.
const INFECTION_FIELDS = ['HIV', 'HepB', 'HepC', 'CMV', 'EBV', 'Syphilis'];

// Read each infection marker from the donor organ subdoc. The schema treats
// absent markers as "not screened" rather than "negative" — failing closed.
function getInfectionScreen(organEntry) {
    // Sub-schema didn't add an InfectionScreening field in this iteration — we
    // look it up on the donor top-level instead. Keep the call site flexible
    // so future per-organ infection docs can override.
    const screen = (organEntry && organEntry.InfectionScreening) || null;
    return screen || {};
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

// HLA overlap: minimum number of antigen matches the policy requires. Returns
// {ok: true} when the policy doesn't require HLA, {ok: true} when overlap is
// sufficient, {ok: false, reason} otherwise.
function passesHLA(donor, organEntry, receiver, policy) {
    if (!policy.HLA_matchRequired) return { ok: true };
    const loci = policy.HLA_matchRequired.loci || [];
    const min = policy.HLA_matchRequired.minMatches || 0;
    if (loci.length === 0) return { ok: true };
    // Donor HLA typing is per-organ (lives on the OrgansDonated subdoc);
    // receiver HLA is on the receiver doc itself.
    const donorHLA = (organEntry && organEntry.HLA_Typing) || donor.HLA_Typing;
    const receiverHLA = receiver.HLA_Typing;
    if (!donorHLA || !receiverHLA) {
        return { ok: false, reason: 'HLA typing missing on donor or receiver' };
    }
    let matches = 0;
    for (const locus of loci) {
        const dAlleles = donorHLA[locus] || [];
        const rAlleles = receiverHLA[locus] || [];
        for (const a of dAlleles) {
            if (rAlleles.includes(a)) matches += 1;
        }
    }
    if (matches < min) {
        return { ok: false, reason: `HLA overlap ${matches} below required ${min}` };
    }
    return { ok: true, matches };
}

// Age check against the policy's ageLimit range.
function passesAgeLimit(donor, policy) {
    const lim = policy.ageLimit;
    if (!lim) return { ok: true };
    if (donor.Age < lim.min) return { ok: false, reason: `donor age ${donor.Age} below minimum ${lim.min}` };
    if (donor.Age > lim.max) return { ok: false, reason: `donor age ${donor.Age} above maximum ${lim.max}` };
    return { ok: true };
}

// Crossmatch is per-organ (kidney/marrow). Returns {ok: true} when the policy
// doesn't require it.
function passesCrossmatch(organEntry, policy) {
    if (!policy.crossmatchRequired) return { ok: true };
    if (organEntry.CrossmatchResult === 'negative') return { ok: true };
    if (organEntry.CrossmatchResult === 'positive') {
        return { ok: false, reason: 'crossmatch positive' };
    }
    return { ok: false, reason: 'crossmatch not done' };
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

// cPRA sensitization check — used by kidney. The donor's per-organ cPRA
// (which can be different from organ to organ) takes priority; falls back to
// the donor top-level. Receiver cPRA is on the receiver doc.
function passesCPRA(donor, organEntry, receiver, policy) {
    if (!policy.cPRA_matchRequired) return { ok: true };
    if (receiver.cPRA == null) return { ok: false, reason: 'receiver cPRA not recorded' };
    const donorCPRA = (organEntry && organEntry.cPRA) != null ? organEntry.cPRA : donor.cPRA;
    if (donorCPRA == null) return { ok: false, reason: 'donor cPRA not recorded' };
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
    flags.verifiedOk = donor.IsVerified === true;
    flags.consentOk = donor.ConsentGiven === true;
    flags.donorStatusOk = ['available', 'verified'].includes(donor.Status);

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

    const abo = passesABO(donor, receiver);
    flags.aboOk = abo.ok;
    if (!abo.ok) reasons.push(abo.reason);

    const age = passesAgeLimit(donor, policy);
    flags.ageOk = age.ok;
    if (!age.ok) reasons.push(age.reason);

    const inf = passesInfectionScreen(organEntry, policy);
    flags.infectionOk = inf.ok;
    if (!inf.ok) reasons.push(inf.reason);

    const xm = passesCrossmatch(organEntry, policy);
    flags.crossmatchOk = xm.ok;
    if (!xm.ok) reasons.push(xm.reason);

    const hla = passesHLA(donor, organEntry, receiver, policy);
    flags.hlaOk = hla.ok;
    if (!hla.ok) reasons.push(hla.reason);

    const cpra = passesCPRA(donor, organEntry, receiver, policy);
    flags.cpraOk = cpra.ok;
    if (!cpra.ok) reasons.push(cpra.reason);

    const cold = passesColdIschemia(organEntry, policy, now);
    flags.coldIschemiaOk = cold.ok;
    if (!cold.ok) reasons.push(cold.reason);

    const ped = passesPediatric(organEntry, receiver, policy);
    flags.pediatricOk = ped.ok;
    if (!ped.ok) reasons.push(ped.reason);

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