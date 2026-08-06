const AppError = require('../utils/AppError');
const Receiver = require('../models/receiver.model');
const { validateLocation } = require('../utils/location');

async function createReceiver(payload) {
    const {
        Name, Age, Gender, BloodGroup,
        State, District, ContactNumber, Email,
        Organ_needed, Urgency,
        Hospital: hospitalId,
        IsVerified,
        Status,
        VerifiedBy,
        WaitlistDate,
        HLA_Typing,
        cPRA,
        SensitizationEvents,
        AcceptsExtendedCriteria,
        AcceptsPediatricOrgan,
        MinOrganWeight_grams,
        MaxOrganWeight_grams,
        DialysisDuration_months
    } = payload;

    const location = validateLocation(State, District);
    if (!location.ok) {
        throw new AppError(location.message, location.status);
    }

    return Receiver.create({
        Name,
        Age,
        Gender,
        BloodGroup,
        State,
        District,
        ContactNumber,
        Email,
        Organ_needed,
        Urgency,
        Hospital: hospitalId,
        IsVerified: IsVerified === true,
        Status: Status || 'pending',
        VerifiedBy: VerifiedBy || undefined,
        WaitlistDate: WaitlistDate || undefined,
        HLA_Typing: HLA_Typing || undefined,
        cPRA: cPRA != null ? cPRA : undefined,
        SensitizationEvents: SensitizationEvents != null ? SensitizationEvents : undefined,
        AcceptsExtendedCriteria: AcceptsExtendedCriteria === true,
        AcceptsPediatricOrgan: AcceptsPediatricOrgan === true,
        MinOrganWeight_grams: MinOrganWeight_grams != null ? MinOrganWeight_grams : undefined,
        MaxOrganWeight_grams: MaxOrganWeight_grams != null ? MaxOrganWeight_grams : undefined,
        DialysisDuration_months: DialysisDuration_months != null ? DialysisDuration_months : undefined
    });
}

async function getMyReceiver(linkedReceiverId) {
    if (!linkedReceiverId) {
        throw new AppError('this account is not linked to a receiver record', 404);
    }

    const receiver = await Receiver.findById(linkedReceiverId).populate('Hospital', 'Name State District');

    if (!receiver) {
        throw new AppError('linked receiver record not found', 404);
    }

    return receiver;
}

// All filters are optional and combine with AND. Returns a list sorted most
// urgent first, then longest-waiting first.
async function listReceivers(query) {
    const { organ, bloodGroup, urgency, state, district, status } = query;
    const filter = {};

    if (organ) filter.Organ_needed = organ;
    if (bloodGroup) filter.BloodGroup = bloodGroup;
    if (urgency) filter.Urgency = urgency;
    if (state) filter.State = state;
    if (district) filter.District = district;
    if (status) filter.Status = status;

    const urgencyOrder = { critical: 0, urgent: 1, stable: 2 };

    const receivers = await Receiver.find(filter)
        .populate('Hospital', 'Name State District')
        .sort({ WaitlistDate: 1 });

    // Sort in memory by urgency — Mongo can't order by an enum's logical
    // position, but the candidate list is small (filtered first).
    receivers.sort((a, b) => urgencyOrder[a.Urgency] - urgencyOrder[b.Urgency]);

    return receivers;
}

async function getReceiverById(id) {
    const receiver = await Receiver.findById(id).populate('Hospital', 'Name State District');
    if (!receiver) {
        throw new AppError('receiver not found', 404);
    }
    return receiver;
}

async function updateReceiver(id, updates) {
    const receiver = await Receiver.findByIdAndUpdate(
        id,
        updates,
        { new: true, runValidators: true }
    );

    if (!receiver) {
        throw new AppError('receiver not found', 404);
    }

    return receiver;
}

module.exports = { createReceiver, getMyReceiver, listReceivers, getReceiverById, updateReceiver };
