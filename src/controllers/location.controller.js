const locationService = require('../services/location.service');

async function listDistricts(req, res) {
    const result = await locationService.listDistrictsForState(req.body.state);
    res.status(200).json(result);
}

module.exports = { listDistricts };
