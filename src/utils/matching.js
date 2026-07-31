const { BLOOD_COMPATIBILITY } = require('../constants/enums');


function getCompatibleDonorBloodGroups(receiverBloodGroup) {
    return Object.entries(BLOOD_COMPATIBILITY)
        .filter(([, canDonateTo]) => canDonateTo.includes(receiverBloodGroup))
        .map(([donorBloodGroup]) => donorBloodGroup);
}

function locationScore(donor, receiver) {
    if (donor.District === receiver.District && donor.State === receiver.State) return 0;
    if (donor.State === receiver.State) return 1;
    return 2;
}


module.exports = { getCompatibleDonorBloodGroups, locationScore };