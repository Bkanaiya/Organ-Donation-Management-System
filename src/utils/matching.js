const { BLOOD_COMPATIBILITY } = require('../constants/enums');


function getCompatibleDonorBloodGroups(receiverBloodGroup) {
    return Object.entries(BLOOD_COMPATIBILITY)
        .filter(([, canDonateTo]) => canDonateTo.includes(receiverBloodGroup))
        .map(([donorBloodGroup]) => donorBloodGroup);
}

// Representative inter-site distances for the district/state tiers, in km.
// The registry has no per-hospital coordinates, so the tier is the only
// location signal we have. These figures are intentionally conservative
// approximations (a district is ~30-60km across, a state ~300-400km, an
// interstate transfer in India ~1000km+).
// NOTE: tier-based location is a coarse signal — a "same district" pair in a
// metro like Mumbai and a "same district" pair in a rural district are both
// ~40km, and two hospitals 5km apart across a district line are counted as
// 1200km. Until the registry records hospital coordinates, location is only
// usable as a tie-breaker, never as a hard eligibility rule.
const SAME_DISTRICT_KM = 40;
const SAME_STATE_KM = 350;
const CROSS_STATE_KM = 1200;

// Estimates the straight-line distance between a donor and a receiver from
// their State/District tiers. Returns { distanceKm, method } where method is
// 'tier' (a tier-estimated value — there are no coordinates in the registry).
// The estimate feeds a smooth, organ-specific decay curve in scoring.js, so a
// heart (short ischemia budget) penalizes distance sharply while a cornea
// (days of shelf life) barely cares.
function distanceKmBetween(donor, receiver) {
    if (!donor || !receiver) {
        return { distanceKm: CROSS_STATE_KM, method: 'tier' };
    }
    if (donor.District === receiver.District && donor.State === receiver.State) {
        return { distanceKm: SAME_DISTRICT_KM, method: 'tier' };
    }
    if (donor.State === receiver.State) {
        return { distanceKm: SAME_STATE_KM, method: 'tier' };
    }
    return { distanceKm: CROSS_STATE_KM, method: 'tier' };
}


module.exports = { getCompatibleDonorBloodGroups, distanceKmBetween };