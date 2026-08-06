const AppError = require('../utils/AppError');
const { getDistrictsForState } = require('../utils/location');

// Returns the list of districts for the requested state. Kept in its own
// service so it can grow (caching, supporting other countries, etc.) without
// touching any other code.
function listDistrictsForState(state) {
    if (!state) {
        throw new AppError('State is required', 400);
    }

    const districts = getDistrictsForState(state);

    if (!districts) {
        throw new AppError('State not found. Please choose a state from India.', 404);
    }

    return {
        state: state.trim(),
        districts
    };
}

module.exports = { listDistrictsForState };
