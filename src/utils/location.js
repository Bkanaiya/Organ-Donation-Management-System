const statesDistricts = require('../data/statesDistricts.json');

/**
 * Validates a state/district pair against the known dataset.
 * Returns { ok: true } on success, or { ok: false, status, message } on failure —
 * callers can spread `status`/`message` straight into an Express error response.
 */
function validateLocation(state, district) {
    if (!state || !district) {
        return { ok: false, status: 400, message: 'State and District are required' };
    }

    const districts = statesDistricts[state.trim()];

    if (!districts) {
        return { ok: false, status: 404, message: 'State not found. Please choose a state from India.' };
    }

    if (!districts.includes(district.trim())) {
        return { ok: false, status: 404, message: 'District not found for this state' };
    }

    return { ok: true };
}

function getDistrictsForState(state) {
    return statesDistricts[state?.trim()] || null;
}

function getAllStates() {
    return Object.keys(statesDistricts);
}

module.exports = { validateLocation, getDistrictsForState, getAllStates };