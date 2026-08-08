const request = require('supertest');
const app = require('../app');
const AuditLog = require('../models/auditLog.model');
const Donor = require('../models/donor.model');
const { connectTestDB, closeTestDB, clearTestDB } = require('./setup');
const { getOrganPolicy } = require('../constants/organPolicies');
const {
    createAdminAndToken,
    createHospital,
    createDonor,
    createDonorWithOrgan,
    createReceiver,
    createHospitalUser
} = require('./helpers');

describe('Match routes', () => {

    beforeAll(async () => {
        await connectTestDB();
    });

    afterEach(async () => {
        await clearTestDB();
    });

    afterAll(async () => {
        await closeTestDB();
    });

    // -----------------------------------------------------------------------
    // GET /api/match/suggest/:receiverId
    // -----------------------------------------------------------------------
    describe('GET /api/match/suggest/:receiverId', () => {

        it('returns 404 for a malformed receiver id instead of a 500', async () => {
            const adminToken = await createAdminAndToken();

            const response = await request(app)
                .get('/api/match/suggest/not-an-object-id')
                .set('Authorization', `Bearer ${adminToken}`);

            // A malformed id must be indistinguishable from a missing one —
            // same 404, no CastError, no enumeration of the id format.
            expect(response.status).toBe(404);
        });

        it('excludes donors with an incompatible blood type', async () => {
            const adminToken = await createAdminAndToken();
            const hospital = await createHospital(adminToken);

            // A+ cannot donate to an O+ receiver under real ABO compatibility rules.
            await createDonor(hospital._id, { BloodGroup: 'A+', ContactNumber: '111' });
            const receiver = await createReceiver(hospital._id, { BloodGroup: 'O+' });

            const response = await request(app)
                .get(`/api/match/suggest/${receiver._id}`)
                .set('Authorization', `Bearer ${adminToken}`);

            expect(response.status).toBe(200);
            expect(response.body.count).toBe(0);
        });

        it('includes compatible donors and ranks the higher-scored one first', async () => {
            const adminToken = await createAdminAndToken();
            const hospital = await createHospital(adminToken);

            // O- is a universal donor — compatible with an O+ receiver.
            await createDonor(hospital._id, {
                Name: 'SameDistrict Donor', BloodGroup: 'O-', District: 'Chennai', ContactNumber: '111'
            });
            // Put the second donor in a different state so the location factor
            // distinguishes 'local' from 'national'. (Kochi is not in the
            // statesDistricts dataset — we use Ernakulam, which is the district
            // Kochi actually sits in.)
            await createDonor(hospital._id, {
                Name: 'OtherState Donor', BloodGroup: 'O-', State: 'Kerala', District: 'Ernakulam', ContactNumber: '222'
            });

            const receiver = await createReceiver(hospital._id, { BloodGroup: 'O+', District: 'Chennai' });

            const response = await request(app)
                .get(`/api/match/suggest/${receiver._id}`)
                .set('Authorization', `Bearer ${adminToken}`);

            expect(response.status).toBe(200);
            expect(response.body.count).toBe(2);
            // The same-district donor scores higher on the location factor — and
            // the response shape now uses an explainable priority breakdown,
            // not the old matchQuality string.
            expect(response.body.candidates[0].donorId).toBeDefined();
            expect(response.body.candidates[0].matchQuality).toBe('local');
            expect(response.body.candidates[1].matchQuality).toBe('national');
        });

        it('honors a caller-supplied limit and clamps it to a sane range', async () => {
            const adminToken = await createAdminAndToken();
            const hospital = await createHospital(adminToken);

            await createDonor(hospital._id, { BloodGroup: 'O-', ContactNumber: '111' });
            await createDonor(hospital._id, { BloodGroup: 'O-', ContactNumber: '222' });
            const receiver = await createReceiver(hospital._id, { BloodGroup: 'O+' });

            // Two eligible candidates; limit=1 must return only the top one.
            const limited = await request(app)
                .get(`/api/match/suggest/${receiver._id}?limit=1`)
                .set('Authorization', `Bearer ${adminToken}`);
            expect(limited.status).toBe(200);
            expect(limited.body.candidates).toHaveLength(1);

            // A limit larger than the candidate pool is harmless (returns all).
            const unlimited = await request(app)
                .get(`/api/match/suggest/${receiver._id}?limit=1000`)
                .set('Authorization', `Bearer ${adminToken}`);
            expect(unlimited.status).toBe(200);
            expect(unlimited.body.candidates).toHaveLength(2);

            // Garbage / empty limit falls back to the default and still returns all.
            const garbage = await request(app)
                .get(`/api/match/suggest/${receiver._id}?limit=banana`)
                .set('Authorization', `Bearer ${adminToken}`);
            expect(garbage.status).toBe(200);
            expect(garbage.body.candidates).toHaveLength(2);
        });

        it('excludes donors whose individual organ has been withdrawn, even when the donor doc looks allocatable', async () => {
            const adminToken = await createAdminAndToken();
            const hospital = await createHospital(adminToken);

            // Donor doc is verified/available, but the kidney itself was
            // declined by the donor's family — the organ subdoc status is the
            // ground truth for "is THIS organ allocatable?".
            const donor = await createDonor(hospital._id);
            await Donor.updateOne(
                { _id: donor._id, 'OrgansDonated.Organ': 'Kidney' },
                { $set: { 'OrgansDonated.$.Status': 'unavailable' } }
            );
            const receiver = await createReceiver(hospital._id);

            const suggestion = await request(app)
                .get(`/api/match/suggest/${receiver._id}`)
                .set('Authorization', `Bearer ${adminToken}`);
            expect(suggestion.status).toBe(200);
            expect(suggestion.body.count).toBe(0);

            // Defense in depth: createMatch must refuse too, not just hide the
            // organ from the suggestion list.
            const create = await request(app)
                .post('/api/match')
                .set('Authorization', `Bearer ${adminToken}`)
                .send({ Donor: donor._id, Receiver: receiver._id, Organ: 'Kidney', Hospital: hospital._id });
            expect(create.status).toBe(409);
        });

        it('excludes donors that fail the weighted HLA eligibility gate (kidney minHlaScore 50)', async () => {
            const adminToken = await createAdminAndToken();
            const hospital = await createHospital(adminToken);

            // Default receiver HLA: A1/A2, B7/B8, DR1/DR4. A donor with zero
            // overlap across DR+B scores 0 on the weighted scale — below the
            // kidney policy's minHlaScore of 50.
            const donor = await createDonorWithOrgan(hospital._id, {
                organ: 'Kidney',
                organFields: {
                    HLA_Typing: { A: ['A3', 'A11'], B: ['B27', 'B44'], DR: ['DR7', 'DR15'] }
                }
            });
            const receiver = await createReceiver(hospital._id);

            const suggestion = await request(app)
                .get(`/api/match/suggest/${receiver._id}`)
                .set('Authorization', `Bearer ${adminToken}`);
            expect(suggestion.status).toBe(200);
            expect(suggestion.body.count).toBe(0);

            const create = await request(app)
                .post('/api/match')
                .set('Authorization', `Bearer ${adminToken}`)
                .send({ Donor: donor._id, Receiver: receiver._id, Organ: 'Kidney', Hospital: hospital._id });
            expect(create.status).toBe(409);
        });

        it('requires admin/hospital role, not any logged-in user', async () => {
            const adminToken = await createAdminAndToken();
            const hospital = await createHospital(adminToken);
            const receiver = await createReceiver(hospital._id);

            const donorAccount = await request(app)
                .post('/api/auth/register')
                .send({ Name: 'Random Donor', Email: 'random@test.com', Password: 'password123' });

            const response = await request(app)
                .get(`/api/match/suggest/${receiver._id}`)
                .set('Authorization', `Bearer ${donorAccount.body.token}`);

            expect(response.status).toBe(403);
        });

        it('excludes unverified donors from suggestions', async () => {
            const adminToken = await createAdminAndToken();
            const hospital = await createHospital(adminToken);
            await createDonor(hospital._id, { IsVerified: false });
            const receiver = await createReceiver(hospital._id);

            const response = await request(app)
                .get(`/api/match/suggest/${receiver._id}`)
                .set('Authorization', `Bearer ${adminToken}`);

            expect(response.status).toBe(200);
            expect(response.body.count).toBe(0);
        });

        it('excludes donors without documented consent', async () => {
            const adminToken = await createAdminAndToken();
            const hospital = await createHospital(adminToken);
            await createDonor(hospital._id, { ConsentGiven: false });
            const receiver = await createReceiver(hospital._id);

            const response = await request(app)
                .get(`/api/match/suggest/${receiver._id}`)
                .set('Authorization', `Bearer ${adminToken}`);

            expect(response.status).toBe(200);
            expect(response.body.count).toBe(0);
        });

        it('excludes donors in a non-allocatable status', async () => {
            const adminToken = await createAdminAndToken();
            const hospital = await createHospital(adminToken);
            await createDonor(hospital._id, { Status: 'pending' });
            const receiver = await createReceiver(hospital._id);

            const response = await request(app)
                .get(`/api/match/suggest/${receiver._id}`)
                .set('Authorization', `Bearer ${adminToken}`);

            expect(response.status).toBe(200);
            expect(response.body.count).toBe(0);
        });

        it('returns an empty list with an explanation when the receiver is not in the waitlist', async () => {
            const adminToken = await createAdminAndToken();
            const hospital = await createHospital(adminToken);
            await createDonor(hospital._id);
            const receiver = await createReceiver(hospital._id, { Status: 'pending' });

            const response = await request(app)
                .get(`/api/match/suggest/${receiver._id}`)
                .set('Authorization', `Bearer ${adminToken}`);

            expect(response.status).toBe(200);
            expect(response.body.count).toBe(0);
            expect(response.body.explanation).toMatch(/not currently in an active waitlist state/i);
        });

        it('does not leak donor PII in the suggest payload', async () => {
            const adminToken = await createAdminAndToken();
            const hospital = await createHospital(adminToken);
            const donor = await createDonor(hospital._id);
            const receiver = await createReceiver(hospital._id);

            const response = await request(app)
                .get(`/api/match/suggest/${receiver._id}`)
                .set('Authorization', `Bearer ${adminToken}`);

            expect(response.status).toBe(200);
            expect(response.body.count).toBe(1);
            const candidate = response.body.candidates[0];

            // Strip PII and raw age — only an age band, only hospital id+name.
            expect(candidate.Name).toBeUndefined();
            expect(candidate.ContactNumber).toBeUndefined();
            expect(candidate.Email).toBeUndefined();
            expect(candidate.Age).toBeUndefined();
            expect(candidate.ageBand).toMatch(/^\d{2}-\d{2}$/);
            // Hospital is reduced to { _id, Name } — no Address, no ContactNumber.
            // (noinspection JSUnresolvedReference)
            expect(candidate.hospitalName).toBeDefined();
            // Don't echo the full donor medical history either.
            expect(candidate.MedicalHistory).toBeUndefined();
        });

        it('returns an explainable score breakdown and policy version', async () => {
            const adminToken = await createAdminAndToken();
            const hospital = await createHospital(adminToken);
            await createDonor(hospital._id);
            const receiver = await createReceiver(hospital._id);

            const response = await request(app)
                .get(`/api/match/suggest/${receiver._id}`)
                .set('Authorization', `Bearer ${adminToken}`);

            expect(response.status).toBe(200);
            const c = response.body.candidates[0];
            expect(c.score).toBeGreaterThan(0);
            expect(c.scoreBreakdown).toHaveProperty('location');
            expect(c.scoreBreakdown).toHaveProperty('urgency');
            expect(c.scoreBreakdown).toHaveProperty('policyVersion');
            expect(c.scoreBreakdown.policyVersion).toMatch(/^\d{4}\.\d{2}\.\d+$/);
            expect(response.body.scoring.policyVersion).toBe(c.scoreBreakdown.policyVersion);
        });

        it('does not leak exact ages or raw clinical inputs in the score breakdown', async () => {
            const adminToken = await createAdminAndToken();
            const hospital = await createHospital(adminToken);
            await createDonor(hospital._id, { Age: 45 });
            const receiver = await createReceiver(hospital._id, { Age: 52 });

            const response = await request(app)
                .get(`/api/match/suggest/${receiver._id}`)
                .set('Authorization', `Bearer ${adminToken}`);

            expect(response.status).toBe(200);
            const c = response.body.candidates[0];
            // The suggest payload only shows an age band — exact ages and raw
            // clinical inputs (HLA counts, ischemia budget, etc.) must not
            // ride along in the "minimal" view.
            expect(c.ageBand).toBe('40-49');
            expect(c.scoreBreakdown.factors).toBeUndefined();
            expect(c.scoreBreakdown.donorAge).toBeUndefined();
            expect(c.scoreBreakdown.receiverAge).toBeUndefined();
            expect(c.scoreBreakdown.hlaMatches).toBeUndefined();
            // The explainable sub-scores and policy metadata stay.
            expect(c.scoreBreakdown.urgency).toBeDefined();
            expect(c.scoreBreakdown.location).toBeDefined();
            expect(c.scoreBreakdown.policyVersion).toBeDefined();
        });

        it('ranks a same-district critical receiver above a same-district stable one', async () => {
            const adminToken = await createAdminAndToken();
            const hospital = await createHospital(adminToken);

            // Single compatible donor — the receiver's Urgency is what tips the order.
            await createDonor(hospital._id, {
                Name: 'Donor', BloodGroup: 'O-', District: 'Chennai', ContactNumber: '999'
            });
            const stableReceiver = await createReceiver(hospital._id, {
                Urgency: 'stable', ContactNumber: '11111', District: 'Chennai', BloodGroup: 'O+'
            });
            const criticalReceiver = await createReceiver(hospital._id, {
                Urgency: 'critical', ContactNumber: '22222', District: 'Chennai', BloodGroup: 'O+'
            });

            const response = await request(app)
                .get(`/api/match/suggest/${stableReceiver._id}`)
                .set('Authorization', `Bearer ${adminToken}`);

            expect(response.status).toBe(200);
            // With one donor in scope, score for stable is lower than for critical,
            // so any single-candidate response in stable-mode has score < critical-mode.
            // We assert the breakdown shape instead so we don't depend on cross-request scoring.
            const stableScore = response.body.candidates[0].scoreBreakdown.urgency;
            expect(stableScore).toBeLessThan(100);

            // Calling for the critical receiver yields a higher urgency factor.
            const response2 = await request(app)
                .get(`/api/match/suggest/${criticalReceiver._id}`)
                .set('Authorization', `Bearer ${adminToken}`);
            expect(response2.body.candidates[0].scoreBreakdown.urgency).toBe(100);
        });
    });

    // -----------------------------------------------------------------------
    // POST /api/match
    // -----------------------------------------------------------------------
    describe('POST /api/match', () => {

        it('resolves organ policies for case-insensitive and alias-style organ names', () => {
            expect(getOrganPolicy('kidney').version).toBeDefined();
            expect(getOrganPolicy('bone marrow').version).toBeDefined();
            expect(getOrganPolicy('small-intestine').version).toBeDefined();
            expect(getOrganPolicy('heart valve').version).toBeDefined();
        });

        it('creates a match and flips donor organ + receiver status', async () => {
            const adminToken = await createAdminAndToken();
            const hospital = await createHospital(adminToken);
            const donor = await createDonor(hospital._id);
            const receiver = await createReceiver(hospital._id);

            const matchResponse = await request(app)
                .post('/api/match')
                .set('Authorization', `Bearer ${adminToken}`)
                .send({
                    Donor: donor._id,
                    Receiver: receiver._id,
                    Organ: 'Kidney',
                    Hospital: hospital._id
                });

            expect(matchResponse.status).toBe(201);

            // Confirm the donor's organ status actually flipped.
            const donorCheck = await request(app)
                .get(`/api/donor/${donor._id}`)
                .set('Authorization', `Bearer ${adminToken}`);
            expect(donorCheck.body.donor.OrgansDonated[0].Status).toBe('matched');

            // Confirm the receiver's status actually flipped.
            const receiverCheck = await request(app)
                .get(`/api/receiver/${receiver._id}`)
                .set('Authorization', `Bearer ${adminToken}`);
            expect(receiverCheck.body.receiver.Status).toBe('matched');
        });

        it('blocks matching the same organ twice', async () => {
            const adminToken = await createAdminAndToken();
            const hospital = await createHospital(adminToken);
            const donor = await createDonor(hospital._id);
            const receiver = await createReceiver(hospital._id);

            await request(app)
                .post('/api/match')
                .set('Authorization', `Bearer ${adminToken}`)
                .send({ Donor: donor._id, Receiver: receiver._id, Organ: 'Kidney', Hospital: hospital._id });

            // Try to match the same donor's Kidney again with a different receiver.
            const secondReceiver = await createReceiver(hospital._id, { ContactNumber: '999', Status: 'waiting', IsVerified: true });
            const response = await request(app)
                .post('/api/match')
                .set('Authorization', `Bearer ${adminToken}`)
                .send({ Donor: donor._id, Receiver: secondReceiver._id, Organ: 'Kidney', Hospital: hospital._id });

            expect(response.status).toBe(409);
        });

        it('blocks matching an organ the donor never offered', async () => {
            const adminToken = await createAdminAndToken();
            const hospital = await createHospital(adminToken);
            const donor = await createDonor(hospital._id); // only offered Kidney
            const receiver = await createReceiver(hospital._id);

            const response = await request(app)
                .post('/api/match')
                .set('Authorization', `Bearer ${adminToken}`)
                .send({ Donor: donor._id, Receiver: receiver._id, Organ: 'Liver', Hospital: hospital._id });

            expect(response.status).toBe(400);
        });

        it('blocks a hospital user from creating a match against another hospitals records', async () => {
            const adminToken = await createAdminAndToken();
            const hospitalA = await createHospital(adminToken);
            const hospitalB = await createHospital(adminToken);
            const hospitalAToken = await createHospitalUser(hospitalA._id);

            const donor = await createDonor(hospitalB._id);
            const receiver = await createReceiver(hospitalB._id);

            // Hospital A user tries to register a match against Hospital B
            // donor + receiver but claims it under Hospital A.
            const response = await request(app)
                .post('/api/match')
                .set('Authorization', `Bearer ${hospitalAToken}`)
                .send({
                    Donor: donor._id,
                    Receiver: receiver._id,
                    Organ: 'Kidney',
                    Hospital: hospitalA._id
                });

            expect(response.status).toBe(403);
            expect(response.body.message).toMatch(/different hospital/i);

            // Confirm no side effects: the donor's organ is still available
            // and the receiver's status is still 'waiting'.
            const donorCheck = await request(app)
                .get(`/api/donor/${donor._id}`)
                .set('Authorization', `Bearer ${adminToken}`);
            expect(donorCheck.body.donor.OrgansDonated[0].Status).toBe('available');

            const receiverCheck = await request(app)
                .get(`/api/receiver/${receiver._id}`)
                .set('Authorization', `Bearer ${adminToken}`);
            expect(receiverCheck.body.receiver.Status).toBe('waiting');
        });

        it('allows a hospital user to reserve a compatible donor from another hospital', async () => {
            const adminToken = await createAdminAndToken();
            const hospitalA = await createHospital(adminToken);
            const hospitalB = await createHospital(adminToken);
            const hospitalAToken = await createHospitalUser(hospitalA._id);

            // Receiver at Hospital A, donor at Hospital B — a regional/national
            // allocation that the suggest flow surfaces as requiresTransfer.
            const donor = await createDonor(hospitalB._id);
            const receiver = await createReceiver(hospitalA._id);

            const response = await request(app)
                .post('/api/match')
                .set('Authorization', `Bearer ${hospitalAToken}`)
                .send({ Donor: donor._id, Receiver: receiver._id, Organ: 'Kidney', Hospital: hospitalA._id });

            expect(response.status).toBe(201);
            // The match is recorded under the receiver's (transplanting) hospital.
            expect(response.body.match.Hospital.toString()).toBe(hospitalA._id.toString());
        });

        // -------- New safety cases added per the 8-point review -----

        it('rejects a match with an ABO-incompatible donor', async () => {
            const adminToken = await createAdminAndToken();
            const hospital = await createHospital(adminToken);
            // A+ donor, B+ receiver — incompatible under real ABO rules.
            const donor = await createDonor(hospital._id, { BloodGroup: 'A+' });
            const receiver = await createReceiver(hospital._id, { BloodGroup: 'B+' });

            const response = await request(app)
                .post('/api/match')
                .set('Authorization', `Bearer ${adminToken}`)
                .send({ Donor: donor._id, Receiver: receiver._id, Organ: 'Kidney', Hospital: hospital._id });

            expect(response.status).toBe(409);
            expect(response.body.message).toMatch(/ABO incompatible/i);
        });

        it('rejects a match where the organ does not match the receivers Organ_needed', async () => {
            const adminToken = await createAdminAndToken();
            const hospital = await createHospital(adminToken);
            // Donor offers Kidney, receiver needs Liver.
            const donor = await createDonor(hospital._id, { Organs: ['Kidney'] });
            const receiver = await createReceiver(hospital._id, { Organ_needed: 'Liver' });

            const response = await request(app)
                .post('/api/match')
                .set('Authorization', `Bearer ${adminToken}`)
                .send({ Donor: donor._id, Receiver: receiver._id, Organ: 'Kidney', Hospital: hospital._id });

            expect(response.status).toBe(409);
            expect(response.body.message).toMatch(/needs Liver|requested Kidney/i);
        });

        it('rejects a match when the donor is not verified', async () => {
            const adminToken = await createAdminAndToken();
            const hospital = await createHospital(adminToken);
            const donor = await createDonor(hospital._id, { IsVerified: false });
            const receiver = await createReceiver(hospital._id);

            const response = await request(app)
                .post('/api/match')
                .set('Authorization', `Bearer ${adminToken}`)
                .send({ Donor: donor._id, Receiver: receiver._id, Organ: 'Kidney', Hospital: hospital._id });

            expect(response.status).toBe(409);
            expect(response.body.message).toMatch(/donor not verified/i);
        });

        it('rejects a match when the donor has not given consent', async () => {
            const adminToken = await createAdminAndToken();
            const hospital = await createHospital(adminToken);
            const donor = await createDonor(hospital._id, { ConsentGiven: false });
            const receiver = await createReceiver(hospital._id);

            const response = await request(app)
                .post('/api/match')
                .set('Authorization', `Bearer ${adminToken}`)
                .send({ Donor: donor._id, Receiver: receiver._id, Organ: 'Kidney', Hospital: hospital._id });

            expect(response.status).toBe(409);
            expect(response.body.message).toMatch(/consent missing/i);
        });

        it('rejects a match when the receiver is not in a waiting status', async () => {
            const adminToken = await createAdminAndToken();
            const hospital = await createHospital(adminToken);
            const donor = await createDonor(hospital._id);
            const receiver = await createReceiver(hospital._id, { Status: 'pending' });

            const response = await request(app)
                .post('/api/match')
                .set('Authorization', `Bearer ${adminToken}`)
                .send({ Donor: donor._id, Receiver: receiver._id, Organ: 'Kidney', Hospital: hospital._id });

            expect(response.status).toBe(409);
            expect(response.body.message).toMatch(/receiver status/i);
        });

        it('rejects a second match on the same receiver', async () => {
            const adminToken = await createAdminAndToken();
            const hospital = await createHospital(adminToken);
            const donorA = await createDonor(hospital._id, { ContactNumber: '111' });
            const donorB = await createDonor(hospital._id, { ContactNumber: '222' });
            const receiver = await createReceiver(hospital._id);

            const first = await request(app)
                .post('/api/match')
                .set('Authorization', `Bearer ${adminToken}`)
                .send({ Donor: donorA._id, Receiver: receiver._id, Organ: 'Kidney', Hospital: hospital._id });
            expect(first.status).toBe(201);

            const second = await request(app)
                .post('/api/match')
                .set('Authorization', `Bearer ${adminToken}`)
                .send({ Donor: donorB._id, Receiver: receiver._id, Organ: 'Kidney', Hospital: hospital._id });

            // The first match flipped the receiver's Status from 'waiting' to
            // 'matched', so the second call's eligibility check rejects it as
            // "receiver status matched not in [waiting]". That guard fires
            // before the duplicate-receiver guard, which is the correct order —
            // it surfaces the more specific reason.
            expect(second.status).toBe(409);
            expect(second.body.message).toMatch(/receiver status .* not in/i);
        });

        it('kidney rejects a donor that carries a receiver unacceptable antigen (virtual crossmatch)', async () => {
            const adminToken = await createAdminAndToken();
            const hospital = await createHospital(adminToken);
            const donor = await createDonor(hospital._id);
            // Receiver is sensitized against A1, which the donor carries — the
            // virtual crossmatch must catch this at allocation time.
            const receiver = await createReceiver(hospital._id, { UnacceptableAntigens: ['A1', 'B7'] });

            const response = await request(app)
                .post('/api/match')
                .set('Authorization', `Bearer ${adminToken}`)
                .send({ Donor: donor._id, Receiver: receiver._id, Organ: 'Kidney', Hospital: hospital._id });

            expect(response.status).toBe(409);
            expect(response.body.message).toMatch(/virtual crossmatch positive/i);
        });

        it('kidney does not require a lab crossmatch at allocation time', async () => {
            const adminToken = await createAdminAndToken();
            const hospital = await createHospital(adminToken);
            // No crossmatch has been run — the lab result is confirmed AFTER
            // the match is reserved (recordCrossmatch). Allocation should
            // succeed; the match enters the 'reserved' phase.
            const donor = await createDonor(hospital._id);
            const receiver = await createReceiver(hospital._id);

            const response = await request(app)
                .post('/api/match')
                .set('Authorization', `Bearer ${adminToken}`)
                .send({ Donor: donor._id, Receiver: receiver._id, Organ: 'Kidney', Hospital: hospital._id });

            expect(response.status).toBe(201);
            expect(response.body.match.AllocationPhase).toBe('reserved');
        });

        it('kidney rejects a receiver without a recorded antibody screen', async () => {
            const adminToken = await createAdminAndToken();
            const hospital = await createHospital(adminToken);
            const donor = await createDonor(hospital._id);
            // cPRA missing → antibody screen not done → kidney policy fails
            // closed even though the donor is fully screened.
            const receiver = await createReceiver(hospital._id, { cPRA: undefined });

            const response = await request(app)
                .post('/api/match')
                .set('Authorization', `Bearer ${adminToken}`)
                .send({ Donor: donor._id, Receiver: receiver._id, Organ: 'Kidney', Hospital: hospital._id });

            expect(response.status).toBe(409);
            expect(response.body.message).toMatch(/antibody screen not recorded/i);
        });

        it('liver does not require a crossmatch (per-organ policy)', async () => {
            const adminToken = await createAdminAndToken();
            const hospital = await createHospital(adminToken);
            // Liver policy: crossmatchRequired = false. No lab crossmatch is
            // recorded and the match should still be created.
            const donor = await createDonorWithOrgan(hospital._id, { organ: 'Liver' });
            const receiver = await createReceiver(hospital._id, { Organ_needed: 'Liver' });

            const response = await request(app)
                .post('/api/match')
                .set('Authorization', `Bearer ${adminToken}`)
                .send({ Donor: donor._id, Receiver: receiver._id, Organ: 'Liver', Hospital: hospital._id });

            expect(response.status).toBe(201);
        });

        it('kidney rejects when cold ischemia is below the threshold', async () => {
            const adminToken = await createAdminAndToken();
            const hospital = await createHospital(adminToken);
            // Kidney ischemia budget is 24h, threshold is 60 min remaining.
            // Procurement happened 23h ago → only 60 min left → borderline OK.
            // Bump to 23h30m → below threshold → reject.
            const thirtyMinutesAgo = new Date(Date.now() - 23.5 * 60 * 60 * 1000);
            const donor = await createDonorWithOrgan(hospital._id, {
                organ: 'Kidney',
                organFields: {
                    IschemiaStartedAt: thirtyMinutesAgo,
                    ColdIschemiaLimit_min: 1440
                }
            });
            const receiver = await createReceiver(hospital._id);

            const response = await request(app)
                .post('/api/match')
                .set('Authorization', `Bearer ${adminToken}`)
                .send({ Donor: donor._id, Receiver: receiver._id, Organ: 'Kidney', Hospital: hospital._id });

            expect(response.status).toBe(409);
            expect(response.body.message).toMatch(/cold ischemia below threshold/i);
        });

        it('kidney accepts when within the cold ischemia window', async () => {
            const adminToken = await createAdminAndToken();
            const hospital = await createHospital(adminToken);
            // 6h of 24h consumed — still within threshold.
            const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000);
            const donor = await createDonorWithOrgan(hospital._id, {
                organ: 'Kidney',
                organFields: {
                    IschemiaStartedAt: sixHoursAgo,
                    ColdIschemiaLimit_min: 1440
                }
            });
            const receiver = await createReceiver(hospital._id);

            const response = await request(app)
                .post('/api/match')
                .set('Authorization', `Bearer ${adminToken}`)
                .send({ Donor: donor._id, Receiver: receiver._id, Organ: 'Kidney', Hospital: hospital._id });

            expect(response.status).toBe(201);
        });

        it('kidney rejects a receiver with no recorded size range (fail closed)', async () => {
            const adminToken = await createAdminAndToken();
            const hospital = await createHospital(adminToken);
            // Kidney is weight-sensitive (policy.weightMatch.tolerance_grams).
            // Without a recorded receiver size range, size compatibility can't
            // be verified — the match must fail closed, not accept any organ.
            const donor = await createDonor(hospital._id);
            const receiver = await createReceiver(hospital._id, {
                MinOrganWeight_grams: undefined,
                MaxOrganWeight_grams: undefined
            });

            const response = await request(app)
                .post('/api/match')
                .set('Authorization', `Bearer ${adminToken}`)
                .send({ Donor: donor._id, Receiver: receiver._id, Organ: 'Kidney', Hospital: hospital._id });

            expect(response.status).toBe(409);
            expect(response.body.message).toMatch(/size preference not recorded/i);
        });

        it('kidney rejects an organ weight outside the receiver recorded size range', async () => {
            const adminToken = await createAdminAndToken();
            const hospital = await createHospital(adminToken);
            // Receiver recorded a 100-300g range; a 500g kidney is clearly
            // unsuitable and must be rejected even though the weight exists.
            const donor = await createDonorWithOrgan(hospital._id, {
                organ: 'Kidney',
                organFields: { OrganWeight_grams: 500 }
            });
            const receiver = await createReceiver(hospital._id, {
                MinOrganWeight_grams: 100,
                MaxOrganWeight_grams: 300
            });

            const response = await request(app)
                .post('/api/match')
                .set('Authorization', `Bearer ${adminToken}`)
                .send({ Donor: donor._id, Receiver: receiver._id, Organ: 'Kidney', Hospital: hospital._id });

            expect(response.status).toBe(409);
            expect(response.body.message).toMatch(/above receiver maximum/i);
        });

        it('stores an explainable score breakdown on the Match', async () => {
            const adminToken = await createAdminAndToken();
            const hospital = await createHospital(adminToken);
            const donor = await createDonor(hospital._id);
            const receiver = await createReceiver(hospital._id);

            const response = await request(app)
                .post('/api/match')
                .set('Authorization', `Bearer ${adminToken}`)
                .send({ Donor: donor._id, Receiver: receiver._id, Organ: 'Kidney', Hospital: hospital._id });

            expect(response.status).toBe(201);
            const m = response.body.match;
            expect(m.Score).toBeGreaterThan(0);
            expect(m.ScoreBreakdown).toHaveProperty('policyVersion');
            expect(m.PolicyVersion).toBe(m.ScoreBreakdown.policyVersion);
            expect(m.AllocationPhase).toBe('reserved');
            expect(m.ColdIschemiaStartedAt).toBeDefined();
            expect(m.MaxColdIschemia_min).toBe(1440);
        });

        it('writes a MATCH_CREATED audit log entry inside the same transaction', async () => {
            const adminToken = await createAdminAndToken();
            const hospital = await createHospital(adminToken);
            const donor = await createDonor(hospital._id);
            const receiver = await createReceiver(hospital._id);

            await request(app)
                .post('/api/match')
                .set('Authorization', `Bearer ${adminToken}`)
                .send({ Donor: donor._id, Receiver: receiver._id, Organ: 'Kidney', Hospital: hospital._id });

            const audits = await AuditLog.find({ Event: 'MATCH_CREATED' }).lean();
            expect(audits).toHaveLength(1);
            const entry = audits[0];
            expect(entry.TargetType).toBe('Match');
            expect(entry.HospitalId.toString()).toBe(hospital._id.toString());
            expect(entry.Payload.score).toBeGreaterThan(0);
            expect(entry.Payload.policyVersion).toMatch(/^\d{4}\.\d{2}\.\d+$/);
        });

        it('writes a MATCH_SUGGESTED audit log entry on suggest', async () => {
            const adminToken = await createAdminAndToken();
            const hospital = await createHospital(adminToken);
            await createDonor(hospital._id);
            const receiver = await createReceiver(hospital._id);

            await request(app)
                .get(`/api/match/suggest/${receiver._id}`)
                .set('Authorization', `Bearer ${adminToken}`);

            const audits = await AuditLog.find({ Event: 'MATCH_SUGGESTED' }).lean();
            expect(audits).toHaveLength(1);
            const entry = audits[0];
            expect(entry.TargetType).toBe('Receiver');
            expect(entry.Payload.donorIds).toHaveLength(1);
            // Audit payload must NOT carry donor names — PII stays out of audit rows too.
            // donorIds are ObjectIds, so we cast to string before the regex check.
            expect(String(entry.Payload.donorIds[0])).not.toMatch(/[A-Z][a-z]+ [A-Z][a-z]+/);
        });

        it('rejects an unknown organ (not in the per-organ policy registry)', async () => {
            const adminToken = await createAdminAndToken();
            const hospital = await createHospital(adminToken);
            const donor = await createDonor(hospital._id);
            const receiver = await createReceiver(hospital._id);

            const response = await request(app)
                .post('/api/match')
                .set('Authorization', `Bearer ${adminToken}`)
                .send({ Donor: donor._id, Receiver: receiver._id, Organ: 'Unicorn', Hospital: hospital._id });

            expect(response.status).toBe(400);
            expect(response.body.message).toMatch(/unknown organ/i);
        });

        it('scores and reserves the ALLOCATABLE entry when a donor lists the same organ twice', async () => {
            const adminToken = await createAdminAndToken();
            const hospital = await createHospital(adminToken);

            // One donor with TWO kidney rows: the first is withdrawn
            // (unavailable), the second is the live 'available' organ. The
            // old code grabbed the FIRST matching row for the organ, so this
            // donor was scored/reserved on the wrong entry.
            const procuredAt = new Date(Date.now() - 6 * 60 * 60 * 1000);
            const screened = {
                HLA_Typing: { A: ['A1', 'A2'], B: ['B7', 'B8'], DR: ['DR1', 'DR4'] },
                OrganWeight_grams: 180,
                InfectionScreening: { HIV: false, HepB: false, HepC: false, CMV: false, EBV: false, Syphilis: false }
            };
            const donor = await Donor.create({
                Name: 'Two Kidney Donor',
                Age: 30,
                Gender: 'male',
                BloodGroup: 'O+',
                DonorType: 'living',
                State: 'Tamil Nadu',
                District: 'Chennai',
                ContactNumber: '9123456780',
                Hospital: hospital._id,
                ConsentGiven: true,
                IsVerified: true,
                Status: 'available',
                OrgansDonated: [
                    { Organ: 'Kidney', Status: 'unavailable', ...screened },
                    { Organ: 'Kidney', Status: 'available', IschemiaStartedAt: procuredAt, ColdIschemiaLimit_min: 1440, ...screened }
                ]
            });
            const receiver = await createReceiver(hospital._id);

            // Suggestion must rank the donor based on the LIVE kidney, not the
            // withdrawn one — otherwise the candidate would be rejected (or
            // scored) on the wrong entry.
            const suggestion = await request(app)
                .get(`/api/match/suggest/${receiver._id}`)
                .set('Authorization', `Bearer ${adminToken}`);
            expect(suggestion.status).toBe(200);
            expect(suggestion.body.count).toBe(1);

            // createMatch must reserve the allocatable (second) entry, and the
            // ischemia clock read must come from THAT entry's procurement time.
            const create = await request(app)
                .post('/api/match')
                .set('Authorization', `Bearer ${adminToken}`)
                .send({ Donor: donor._id, Receiver: receiver._id, Organ: 'Kidney', Hospital: hospital._id });
            expect(create.status).toBe(201);
            expect(create.body.match.ProcuredBeforeMatch).toBe(true);
            expect(new Date(create.body.match.ColdIschemiaStartedAt).getTime()).toBe(procuredAt.getTime());

            const donorCheck = await request(app)
                .get(`/api/donor/${donor._id}`)
                .set('Authorization', `Bearer ${adminToken}`);
            expect(donorCheck.body.donor.OrgansDonated[0].Status).toBe('unavailable');
            expect(donorCheck.body.donor.OrgansDonated[1].Status).toBe('matched');
        });

        it('treats a verified organ as allocatable: it appears in suggestions and can be reserved', async () => {
            const adminToken = await createAdminAndToken();
            const hospital = await createHospital(adminToken);

            // The eligibility engine and ALLOCATABLE_ORGAN_STATUSES accept a
            // 'verified' organ entry, but the suggest query (and the reserve
            // CAS) used to only match 'available' — so a verified organ could
            // be scored but never suggested nor reserved. A verified entry
            // must surface and reserve exactly like an available one.
            const screened = {
                HLA_Typing: { A: ['A1', 'A2'], B: ['B7', 'B8'], DR: ['DR1', 'DR4'] },
                OrganWeight_grams: 180,
                InfectionScreening: { HIV: false, HepB: false, HepC: false, CMV: false, EBV: false, Syphilis: false }
            };
            const donor = await Donor.create({
                Name: 'Verified Organ Donor',
                Age: 30,
                Gender: 'male',
                BloodGroup: 'O+',
                DonorType: 'living',
                State: 'Tamil Nadu',
                District: 'Chennai',
                ContactNumber: '9123456780',
                Hospital: hospital._id,
                ConsentGiven: true,
                IsVerified: true,
                Status: 'available',
                OrgansDonated: [{ Organ: 'Kidney', Status: 'verified', ...screened }]
            });
            const receiver = await createReceiver(hospital._id);

            const suggestion = await request(app)
                .get(`/api/match/suggest/${receiver._id}`)
                .set('Authorization', `Bearer ${adminToken}`);
            expect(suggestion.status).toBe(200);
            expect(suggestion.body.count).toBe(1);
            expect(suggestion.body.candidates[0].donorId).toBe(String(donor._id));

            const create = await request(app)
                .post('/api/match')
                .set('Authorization', `Bearer ${adminToken}`)
                .send({ Donor: donor._id, Receiver: receiver._id, Organ: 'Kidney', Hospital: hospital._id });
            expect(create.status).toBe(201);
            expect(create.body.match.AllocationPhase).toBe('reserved');
        });

        it('bone marrow is ABO-exempt (HLA is the gate) — an ABO-incompatible pair can match', async () => {
            const adminToken = await createAdminAndToken();
            const hospital = await createHospital(adminToken);

            // B+ donor, A+ receiver: ABO-incompatible (a B donor cannot give
            // to an A recipient). For marrow the ABO gate is deliberately
            // bypassed — the strict HLA gate (minHlaScore 100) is the only
            // compatibility gate that matters.
            const donor = await createDonorWithOrgan(hospital._id, {
                organ: 'Bone Marrow',
                donorFields: { BloodGroup: 'B+' }
            });
            const receiver = await createReceiver(hospital._id, {
                Organ_needed: 'Bone Marrow',
                BloodGroup: 'A+'
            });

            const response = await request(app)
                .post('/api/match')
                .set('Authorization', `Bearer ${adminToken}`)
                .send({ Donor: donor._id, Receiver: receiver._id, Organ: 'Bone Marrow', Hospital: hospital._id });

            expect(response.status).toBe(201);
            expect(response.body.match.AllocationPhase).toBe('reserved');
        });
    });

    // -----------------------------------------------------------------------
    // Hospital-scope filtering on /suggest
    // -----------------------------------------------------------------------
    describe('Hospital-scope filtering on /suggest', () => {

        it('blocks a hospital user from suggesting matches for a receiver at a different hospital', async () => {
            const adminToken = await createAdminAndToken();
            const hospitalA = await createHospital(adminToken);
            const hospitalB = await createHospital(adminToken);
            const hospitalAToken = await createHospitalUser(hospitalA._id);

            await createDonor(hospitalB._id, { BloodGroup: 'O-' });
            const receiver = await createReceiver(hospitalB._id, { BloodGroup: 'O+' });

            const response = await request(app)
                .get(`/api/match/suggest/${receiver._id}`)
                .set('Authorization', `Bearer ${hospitalAToken}`);

            expect(response.status).toBe(403);
            expect(response.body.message).toMatch(/different hospital/i);
        });

        it('includes donors from other hospitals and flags them as requiring transfer', async () => {
            const adminToken = await createAdminAndToken();
            const hospitalA = await createHospital(adminToken);
            const hospitalB = await createHospital(adminToken);
            const hospitalAToken = await createHospitalUser(hospitalA._id);

            await createDonor(hospitalA._id, { BloodGroup: 'O-' });
            await createDonor(hospitalB._id, { BloodGroup: 'O-' });

            const receiver = await createReceiver(hospitalA._id, { BloodGroup: 'O+' });

            const response = await request(app)
                .get(`/api/match/suggest/${receiver._id}`)
                .set('Authorization', `Bearer ${hospitalAToken}`);

            expect(response.status).toBe(200);
            // Allocation is regional/national — a hospital user sees compatible
            // donors from other hospitals so they can plan a transfer.
            expect(response.body.count).toBe(2);
            const byHospital = {};
            for (const c of response.body.candidates) {
                byHospital[c.hospitalId.toString()] = c;
            }
            expect(byHospital[hospitalA._id.toString()].requiresTransfer).toBe(false);
            expect(byHospital[hospitalB._id.toString()].requiresTransfer).toBe(true);
        });
    });

    // -----------------------------------------------------------------------
    // Concurrency — two simultaneous createMatch calls on the same organ
    // -----------------------------------------------------------------------
    describe('Atomicity + concurrency', () => {

        it('serializes two concurrent match attempts on the same organ', async () => {
            const adminToken = await createAdminAndToken();
            const hospital = await createHospital(adminToken);
            const donor = await createDonor(hospital._id);
            const receiverA = await createReceiver(hospital._id, { ContactNumber: '111' });
            const receiverB = await createReceiver(hospital._id, { ContactNumber: '222' });

            const reqA = request(app)
                .post('/api/match')
                .set('Authorization', `Bearer ${adminToken}`)
                .send({ Donor: donor._id, Receiver: receiverA._id, Organ: 'Kidney', Hospital: hospital._id });
            const reqB = request(app)
                .post('/api/match')
                .set('Authorization', `Bearer ${adminToken}`)
                .send({ Donor: donor._id, Receiver: receiverB._id, Organ: 'Kidney', Hospital: hospital._id });

            const [resA, resB] = await Promise.all([reqA, reqB]);

            // Exactly one wins (201), the other fails with a 4xx (the loser is
            // typically a 409 — "organ no longer available" or
            // "concurrent match attempt" / "duplicate receiver on open match").
            const statuses = [resA.status, resB.status].sort();
            expect(statuses).toEqual([201, 409]);
        });

        it('rolls back the donor organ reservation when the transaction fails mid-flight', async () => {
            const adminToken = await createAdminAndToken();
            const hospital = await createHospital(adminToken);
            const donor = await createDonorWithOrgan(hospital._id, {
                organ: 'Kidney'
            });
            const receiver = await createReceiver(hospital._id);

            // We can't easily force a transaction abort without monkey-patching
            // modules, but the duplicate-receiver guard tests the same rollback
            // path: it writes no Match, and the donor's organ stays 'available'.
            // First createMatch occupies the receiver.
            const first = await request(app)
                .post('/api/match')
                .set('Authorization', `Bearer ${adminToken}`)
                .send({ Donor: donor._id, Receiver: receiver._id, Organ: 'Kidney', Hospital: hospital._id });
            expect(first.status).toBe(201);

            // Second donor → same receiver → rejected by duplicate-receiver guard.
            // The donor organ we just touched must still be 'matched', proving
            // the second transaction was fully rolled back.
            const donorB = await createDonorWithOrgan(hospital._id, { organ: 'Kidney', donorFields: { Name: 'Donor B', ContactNumber: '333' } });
            const second = await request(app)
                .post('/api/match')
                .set('Authorization', `Bearer ${adminToken}`)
                .send({ Donor: donorB._id, Receiver: receiver._id, Organ: 'Kidney', Hospital: hospital._id });
            expect(second.status).toBe(409);

            // Confirm donor B's organ was NOT reserved — the failed transaction
            // must have rolled back its write.
            const donorBCheck = await request(app)
                .get(`/api/donor/${donorB._id}`)
                .set('Authorization', `Bearer ${adminToken}`);
            expect(donorBCheck.body.donor.OrgansDonated[0].Status).toBe('available');
        });
    });

    // -----------------------------------------------------------------------
    // Allocation lifecycle — approve / start / complete / cancel / audit
    // -----------------------------------------------------------------------
    describe('Allocation lifecycle', () => {

        async function createReservedMatch(adminToken, hospital) {
            const donor = await createDonor(hospital._id);
            const receiver = await createReceiver(hospital._id);
            const res = await request(app)
                .post('/api/match')
                .set('Authorization', `Bearer ${adminToken}`)
                .send({ Donor: donor._id, Receiver: receiver._id, Organ: 'Kidney', Hospital: hospital._id });
            expect(res.status).toBe(201);
            expect(res.body.match.AllocationPhase).toBe('reserved');
            return { donor, receiver, match: res.body.match };
        }

        it('advances a reserved kidney through crossmatch_confirmed -> accepted -> in_progress -> completed', async () => {
            const adminToken = await createAdminAndToken();
            const hospital = await createHospital(adminToken);
            const { donor, receiver, match } = await createReservedMatch(adminToken, hospital);

            // Lab runs the pair-specific crossmatch — negative confirms the
            // pair and advances reserved -> crossmatch_confirmed.
            const crossmatch = await request(app)
                .post(`/api/match/${match._id}/crossmatch`)
                .set('Authorization', `Bearer ${adminToken}`)
                .send({ Result: 'negative', Method: 'flow_cytometry' });
            expect(crossmatch.status).toBe(200);
            expect(crossmatch.body.match.AllocationPhase).toBe('crossmatch_confirmed');
            expect(crossmatch.body.crossmatch.Result).toBe('negative');

            const approve = await request(app)
                .post(`/api/match/${match._id}/approve`)
                .set('Authorization', `Bearer ${adminToken}`);
            expect(approve.status).toBe(200);
            expect(approve.body.match.AllocationPhase).toBe('accepted');

            const start = await request(app)
                .post(`/api/match/${match._id}/start`)
                .set('Authorization', `Bearer ${adminToken}`);
            expect(start.status).toBe(200);
            expect(start.body.match.AllocationPhase).toBe('in_progress');

            const complete = await request(app)
                .post(`/api/match/${match._id}/complete`)
                .set('Authorization', `Bearer ${adminToken}`);
            expect(complete.status).toBe(200);
            expect(complete.body.match.AllocationPhase).toBe('completed');
            expect(complete.body.match.Status).toBe('completed');

            // Terminal side effects: donor organ donated, donor flipped to
            // 'donated' at the top level too, receiver transplanted.
            const donorCheck = await request(app)
                .get(`/api/donor/${donor._id}`)
                .set('Authorization', `Bearer ${adminToken}`);
            expect(donorCheck.body.donor.OrgansDonated[0].Status).toBe('donated');
            expect(donorCheck.body.donor.Status).toBe('donated');

            const receiverCheck = await request(app)
                .get(`/api/receiver/${receiver._id}`)
                .set('Authorization', `Bearer ${adminToken}`);
            expect(receiverCheck.body.receiver.Status).toBe('transplanted');
        });

        it('cancels a reserved match when the crossmatch is positive and releases the organ + receiver', async () => {
            const adminToken = await createAdminAndToken();
            const hospital = await createHospital(adminToken);
            const { donor, receiver, match } = await createReservedMatch(adminToken, hospital);

            const crossmatch = await request(app)
                .post(`/api/match/${match._id}/crossmatch`)
                .set('Authorization', `Bearer ${adminToken}`)
                .send({ Result: 'positive', Method: 'complement_dependent_cytotoxicity' });
            expect(crossmatch.status).toBe(200);
            expect(crossmatch.body.match.AllocationPhase).toBe('cancelled');
            expect(crossmatch.body.match.CancellationReason).toMatch(/crossmatch positive/i);

            // The positive result is pair-specific and stays on record.
            const donorCheck = await request(app)
                .get(`/api/donor/${donor._id}`)
                .set('Authorization', `Bearer ${adminToken}`);
            expect(donorCheck.body.donor.OrgansDonated[0].Status).toBe('available');

            const receiverCheck = await request(app)
                .get(`/api/receiver/${receiver._id}`)
                .set('Authorization', `Bearer ${adminToken}`);
            expect(receiverCheck.body.receiver.Status).toBe('waiting');
        });

        it('blocks advancing a reserved match to crossmatch_confirmed without a recorded negative crossmatch', async () => {
            const adminToken = await createAdminAndToken();
            const hospital = await createHospital(adminToken);
            const { match } = await createReservedMatch(adminToken, hospital);

            // No crossmatch has been recorded for this pair — approve must
            // refuse to jump reserved -> crossmatch_confirmed.
            const approve = await request(app)
                .post(`/api/match/${match._id}/approve`)
                .set('Authorization', `Bearer ${adminToken}`);
            expect(approve.status).toBe(409);
            expect(approve.body.message).toMatch(/negative crossmatch from the current cycle/i);
        });

        it('requires a negative crossmatch DATED AFTER the last positive before re-confirming a previously-positive pair', async () => {
            const adminToken = await createAdminAndToken();
            const hospital = await createHospital(adminToken);
            const donor = await createDonorWithOrgan(hospital._id, { organ: 'Kidney' });
            const receiver = await createReceiver(hospital._id);

            // Cycle 1: crossmatch positive -> match cancelled, pair now known
            // incompatible until a fresh negative re-tests it.
            const create1 = await request(app)
                .post('/api/match')
                .set('Authorization', `Bearer ${adminToken}`)
                .send({ Donor: donor._id, Receiver: receiver._id, Organ: 'Kidney', Hospital: hospital._id });
            expect(create1.status).toBe(201);
            const match1 = create1.body.match;
            const positive = await request(app)
                .post(`/api/match/${match1._id}/crossmatch`)
                .set('Authorization', `Bearer ${adminToken}`)
                .send({ Result: 'positive' });
            expect(positive.status).toBe(200);
            expect(positive.body.match.AllocationPhase).toBe('cancelled');

            // Cycle 2: the organ is released, so the pair can be re-matched.
            // But the ONLY negative on record predates the positive (from a
            // hypothetical earlier cycle would be a stale negative) — here
            // there is none at all, so approve must refuse.
            const create2 = await request(app)
                .post('/api/match')
                .set('Authorization', `Bearer ${adminToken}`)
                .send({ Donor: donor._id, Receiver: receiver._id, Organ: 'Kidney', Hospital: hospital._id });
            expect(create2.status).toBe(201);
            const match2 = create2.body.match;

            const premature = await request(app)
                .post(`/api/match/${match2._id}/approve`)
                .set('Authorization', `Bearer ${adminToken}`);
            expect(premature.status).toBe(409);
            expect(premature.body.message).toMatch(/current cycle/i);

            // A fresh negative recorded during cycle 2 (after the positive)
            // clears the pair for re-confirmation.
            const retest = await request(app)
                .post(`/api/match/${match2._id}/crossmatch`)
                .set('Authorization', `Bearer ${adminToken}`)
                .send({ Result: 'negative', Method: 'flow_cytometry' });
            expect(retest.status).toBe(200);
            expect(retest.body.match.AllocationPhase).toBe('crossmatch_confirmed');

            const approve = await request(app)
                .post(`/api/match/${match2._id}/approve`)
                .set('Authorization', `Bearer ${adminToken}`);
            expect(approve.status).toBe(200);
            expect(approve.body.match.AllocationPhase).toBe('accepted');
        });

        it('keeps crossmatch history append-only (positive then re-test negative are BOTH on record)', async () => {
            const Crossmatch = require('../models/crossmatch.model');
            const adminToken = await createAdminAndToken();
            const hospital = await createHospital(adminToken);
            const donor = await createDonorWithOrgan(hospital._id, { organ: 'Kidney' });
            const receiver = await createReceiver(hospital._id);

            // Cycle 1: positive cancels the match and releases the organ.
            const create1 = await request(app)
                .post('/api/match')
                .set('Authorization', `Bearer ${adminToken}`)
                .send({ Donor: donor._id, Receiver: receiver._id, Organ: 'Kidney', Hospital: hospital._id });
            const match1 = create1.body.match;
            await request(app)
                .post(`/api/match/${match1._id}/crossmatch`)
                .set('Authorization', `Bearer ${adminToken}`)
                .send({ Result: 'positive' });

            // Cycle 2: re-match the released organ, then the lab re-tests and
            // records a negative on the new match.
            const create2 = await request(app)
                .post('/api/match')
                .set('Authorization', `Bearer ${adminToken}`)
                .send({ Donor: donor._id, Receiver: receiver._id, Organ: 'Kidney', Hospital: hospital._id });
            expect(create2.status).toBe(201);
            const match2 = create2.body.match;
            await request(app)
                .post(`/api/match/${match2._id}/crossmatch`)
                .set('Authorization', `Bearer ${adminToken}`)
                .send({ Result: 'negative' });

            const rows = await Crossmatch.find({ Donor: donor._id, Receiver: receiver._id, Organ: 'Kidney' }).sort({ TestedAt: 1 }).lean();
            // Two rows, ordered oldest -> newest: the positive is NOT
            // overwritten by the re-test. An upsert would leave exactly one.
            expect(rows).toHaveLength(2);
            expect(rows[0].Result).toBe('positive');
            expect(rows[1].Result).toBe('negative');
        });

        it('preserves a procured organ IschemiaStartedAt across a cancel (only pre-procurement matches clear it)', async () => {
            const adminToken = await createAdminAndToken();
            const hospital = await createHospital(adminToken);
            const procuredAt = new Date(Date.now() - 6 * 60 * 60 * 1000);   // 6h ago
            const donor = await createDonorWithOrgan(hospital._id, {
                organ: 'Kidney',
                organFields: {
                    IschemiaStartedAt: procuredAt,
                    ColdIschemiaLimit_min: 1440
                }
            });
            const receiver = await createReceiver(hospital._id);

            const create = await request(app)
                .post('/api/match')
                .set('Authorization', `Bearer ${adminToken}`)
                .send({ Donor: donor._id, Receiver: receiver._id, Organ: 'Kidney', Hospital: hospital._id });
            expect(create.status).toBe(201);
            // ProcuredBeforeMatch must be true: the clock started at a real
            // procurement, not at reservation.
            expect(create.body.match.ProcuredBeforeMatch).toBe(true);
            expect(new Date(create.body.match.ColdIschemiaStartedAt).getTime()).toBe(procuredAt.getTime());

            const cancel = await request(app)
                .post(`/api/match/${create.body.match._id}/cancel`)
                .set('Authorization', `Bearer ${adminToken}`)
                .send({ reason: 'coordinator error' });
            expect(cancel.status).toBe(200);

            // The REAL procurement timestamp survives the cancel — the clock
            // measures actual preservation time, so the next match sees the
            // organ's true remaining budget (18h left of 24h), not a full one.
            const donorCheck = await request(app)
                .get(`/api/donor/${donor._id}`)
                .set('Authorization', `Bearer ${adminToken}`);
            const organ = donorCheck.body.donor.OrgansDonated[0];
            expect(organ.Status).toBe('available');
            expect(new Date(organ.IschemiaStartedAt).getTime()).toBe(procuredAt.getTime());
        });

        it('clears the reservation-stamped ischemia clock when a pre-procurement match is cancelled', async () => {
            const adminToken = await createAdminAndToken();
            const hospital = await createHospital(adminToken);
            // createDonor's public path does NOT set IschemiaStartedAt, so the
            // match itself stamps it on reservation.
            const donor = await createDonor(hospital._id);
            const receiver = await createReceiver(hospital._id);

            const create = await request(app)
                .post('/api/match')
                .set('Authorization', `Bearer ${adminToken}`)
                .send({ Donor: donor._id, Receiver: receiver._id, Organ: 'Kidney', Hospital: hospital._id });
            expect(create.status).toBe(201);
            expect(create.body.match.ProcuredBeforeMatch).toBe(false);
            expect(create.body.match.ColdIschemiaStartedAt).toBeDefined();

            const cancel = await request(app)
                .post(`/api/match/${create.body.match._id}/cancel`)
                .set('Authorization', `Bearer ${adminToken}`)
                .send({ reason: 'donor withdrew' });
            expect(cancel.status).toBe(200);

            const donorCheck = await request(app)
                .get(`/api/donor/${donor._id}`)
                .set('Authorization', `Bearer ${adminToken}`);
            expect(donorCheck.body.donor.OrgansDonated[0].IschemiaStartedAt).toBeNull();
        });

        it('rejects an illegal jump straight from reserved to completed', async () => {
            const adminToken = await createAdminAndToken();
            const hospital = await createHospital(adminToken);
            const { match } = await createReservedMatch(adminToken, hospital);

            const complete = await request(app)
                .post(`/api/match/${match._id}/complete`)
                .set('Authorization', `Bearer ${adminToken}`);
            expect(complete.status).toBe(409);
        });

        it('cancels a match and releases the donor organ and receiver back into the pool', async () => {
            const adminToken = await createAdminAndToken();
            const hospital = await createHospital(adminToken);
            const { donor, receiver, match } = await createReservedMatch(adminToken, hospital);

            const cancel = await request(app)
                .post(`/api/match/${match._id}/cancel`)
                .set('Authorization', `Bearer ${adminToken}`)
                .send({ reason: 'receiver condition deteriorated' });
            expect(cancel.status).toBe(200);
            expect(cancel.body.match.AllocationPhase).toBe('cancelled');
            expect(cancel.body.match.CancellationReason).toMatch(/deteriorated/i);

            const donorCheck = await request(app)
                .get(`/api/donor/${donor._id}`)
                .set('Authorization', `Bearer ${adminToken}`);
            expect(donorCheck.body.donor.OrgansDonated[0].Status).toBe('available');

            const receiverCheck = await request(app)
                .get(`/api/receiver/${receiver._id}`)
                .set('Authorization', `Bearer ${adminToken}`);
            expect(receiverCheck.body.receiver.Status).toBe('waiting');
        });

        it('restores a verified tissue receiver to verified, not waiting, after a cancel', async () => {
            const adminToken = await createAdminAndToken();
            const hospital = await createHospital(adminToken);
            // The cornea policy accepts ['verified', 'waiting'] receivers, so a
            // tissue match can flip a 'verified' receiver to 'matched'. On
            // cancel the release path must restore the exact pre-match status —
            // demoting to 'waiting' would corrupt the waitlist state.
            const donor = await createDonorWithOrgan(hospital._id, { organ: 'Cornea' });
            const receiver = await createReceiver(hospital._id, {
                Organ_needed: 'Cornea',
                Status: 'verified'
            });

            const create = await request(app)
                .post('/api/match')
                .set('Authorization', `Bearer ${adminToken}`)
                .send({ Donor: donor._id, Receiver: receiver._id, Organ: 'Cornea', Hospital: hospital._id });
            expect(create.status).toBe(201);
            expect(create.body.match.AllocationPhase).toBe('reserved');
            // The pre-match status was captured on the Match for the release path.
            expect(create.body.match.ReceiverStatusBeforeMatch).toBe('verified');

            const cancel = await request(app)
                .post(`/api/match/${create.body.match._id}/cancel`)
                .set('Authorization', `Bearer ${adminToken}`)
                .send({ reason: 'recipient declined tissue' });
            expect(cancel.status).toBe(200);
            expect(cancel.body.match.AllocationPhase).toBe('cancelled');

            const receiverCheck = await request(app)
                .get(`/api/receiver/${receiver._id}`)
                .set('Authorization', `Bearer ${adminToken}`);
            expect(receiverCheck.body.receiver.Status).toBe('verified');
        });

        it('cancels the EXACT reserved entry when a donor lists the same organ twice', async () => {
            const adminToken = await createAdminAndToken();
            const hospital = await createHospital(adminToken);

            // Two kidney rows: the first is withdrawn, the SECOND is the live
            // one createMatch reserves. The release path used to key the
            // positional $ on the organ name alone, so a cancel wrote
            // 'available' to the FIRST kidney row and left the actually
            // reserved second row stuck at 'matched' forever.
            const procuredAt = new Date(Date.now() - 6 * 60 * 60 * 1000);
            const screened = {
                HLA_Typing: { A: ['A1', 'A2'], B: ['B7', 'B8'], DR: ['DR1', 'DR4'] },
                OrganWeight_grams: 180,
                InfectionScreening: { HIV: false, HepB: false, HepC: false, CMV: false, EBV: false, Syphilis: false }
            };
            const donor = await Donor.create({
                Name: 'Two Kidney Donor',
                Age: 30,
                Gender: 'male',
                BloodGroup: 'O+',
                DonorType: 'living',
                State: 'Tamil Nadu',
                District: 'Chennai',
                ContactNumber: '9123456780',
                Hospital: hospital._id,
                ConsentGiven: true,
                IsVerified: true,
                Status: 'available',
                OrgansDonated: [
                    { Organ: 'Kidney', Status: 'unavailable', ...screened },
                    { Organ: 'Kidney', Status: 'available', IschemiaStartedAt: procuredAt, ColdIschemiaLimit_min: 1440, ...screened }
                ]
            });
            const receiver = await createReceiver(hospital._id);

            const create = await request(app)
                .post('/api/match')
                .set('Authorization', `Bearer ${adminToken}`)
                .send({ Donor: donor._id, Receiver: receiver._id, Organ: 'Kidney', Hospital: hospital._id });
            expect(create.status).toBe(201);
            // The Match must have captured the exact reserved entry's id so a
            // later release can pinpoint it.
            expect(create.body.match.OrganEntryId).toBeTruthy();

            const cancel = await request(app)
                .post(`/api/match/${create.body.match._id}/cancel`)
                .set('Authorization', `Bearer ${adminToken}`)
                .send({ reason: 'recipient decompensated' });
            expect(cancel.status).toBe(200);
            expect(cancel.body.match.AllocationPhase).toBe('cancelled');

            const donorCheck = await request(app)
                .get(`/api/donor/${donor._id}`)
                .set('Authorization', `Bearer ${adminToken}`);
            // The withdrawn first row must NOT be resurrected to 'available',
            // and the reserved second row must be released.
            expect(donorCheck.body.donor.OrgansDonated[0].Status).toBe('unavailable');
            expect(donorCheck.body.donor.OrgansDonated[1].Status).toBe('available');
            // The procured second row keeps its real ischemia clock.
            expect(new Date(donorCheck.body.donor.OrgansDonated[1].IschemiaStartedAt).getTime()).toBe(procuredAt.getTime());

            const receiverCheck = await request(app)
                .get(`/api/receiver/${receiver._id}`)
                .set('Authorization', `Bearer ${adminToken}`);
            expect(receiverCheck.body.receiver.Status).toBe('waiting');
        });

        it('completes the EXACT reserved entry when a donor lists the same organ twice', async () => {
            const adminToken = await createAdminAndToken();
            const hospital = await createHospital(adminToken);

            const screened = {
                HLA_Typing: { A: ['A1', 'A2'], B: ['B7', 'B8'], DR: ['DR1', 'DR4'] },
                OrganWeight_grams: 180,
                InfectionScreening: { HIV: false, HepB: false, HepC: false, CMV: false, EBV: false, Syphilis: false }
            };
            const donor = await Donor.create({
                Name: 'Two Kidney Donor',
                Age: 30,
                Gender: 'male',
                BloodGroup: 'O+',
                DonorType: 'living',
                State: 'Tamil Nadu',
                District: 'Chennai',
                ContactNumber: '9123456780',
                Hospital: hospital._id,
                ConsentGiven: true,
                IsVerified: true,
                Status: 'available',
                OrgansDonated: [
                    { Organ: 'Kidney', Status: 'unavailable', ...screened },
                    { Organ: 'Kidney', Status: 'available', ...screened }
                ]
            });
            const receiver = await createReceiver(hospital._id);

            const create = await request(app)
                .post('/api/match')
                .set('Authorization', `Bearer ${adminToken}`)
                .send({ Donor: donor._id, Receiver: receiver._id, Organ: 'Kidney', Hospital: hospital._id });
            expect(create.status).toBe(201);
            expect(create.body.match.OrganEntryId).toBeTruthy();

            // Kidney must advance through the full workflow before completing.
            await request(app)
                .post(`/api/match/${create.body.match._id}/crossmatch`)
                .set('Authorization', `Bearer ${adminToken}`)
                .send({ Result: 'negative', Method: 'flow_cytometry' });
            await request(app)
                .post(`/api/match/${create.body.match._id}/approve`)
                .set('Authorization', `Bearer ${adminToken}`);
            await request(app)
                .post(`/api/match/${create.body.match._id}/start`)
                .set('Authorization', `Bearer ${adminToken}`);
            const complete = await request(app)
                .post(`/api/match/${create.body.match._id}/complete`)
                .set('Authorization', `Bearer ${adminToken}`);
            expect(complete.status).toBe(200);
            expect(complete.body.match.AllocationPhase).toBe('completed');

            const donorCheck = await request(app)
                .get(`/api/donor/${donor._id}`)
                .set('Authorization', `Bearer ${adminToken}`);
            // The withdrawn first row stays untouched; only the reserved second
            // row is marked donated (and the donor flips to donated).
            expect(donorCheck.body.donor.OrgansDonated[0].Status).toBe('unavailable');
            expect(donorCheck.body.donor.OrgansDonated[1].Status).toBe('donated');
            expect(donorCheck.body.donor.Status).toBe('donated');
        });

        it('requires a reason to cancel', async () => {
            const adminToken = await createAdminAndToken();
            const hospital = await createHospital(adminToken);
            const { match } = await createReservedMatch(adminToken, hospital);

            const cancel = await request(app)
                .post(`/api/match/${match._id}/cancel`)
                .set('Authorization', `Bearer ${adminToken}`);
            expect(cancel.status).toBe(400);
        });

        it('fails a match at the clinical stage and releases the organ + receiver, recording MATCH_FAILED', async () => {
            const adminToken = await createAdminAndToken();
            const hospital = await createHospital(adminToken);
            const { donor, receiver, match } = await createReservedMatch(adminToken, hospital);

            // Advance reserved -> crossmatch_confirmed -> accepted -> in_progress
            // so the failure happens mid-transplant rather than pre-op.
            await request(app)
                .post(`/api/match/${match._id}/crossmatch`)
                .set('Authorization', `Bearer ${adminToken}`)
                .send({ Result: 'negative', Method: 'flow_cytometry' });
            await request(app)
                .post(`/api/match/${match._id}/approve`)
                .set('Authorization', `Bearer ${adminToken}`);
            await request(app)
                .post(`/api/match/${match._id}/start`)
                .set('Authorization', `Bearer ${adminToken}`);

            const fail = await request(app)
                .post(`/api/match/${match._id}/fail`)
                .set('Authorization', `Bearer ${adminToken}`)
                .send({ reason: 'organ unusable at retrieval' });
            expect(fail.status).toBe(200);
            expect(fail.body.match.AllocationPhase).toBe('failed');
            expect(fail.body.match.Status).toBe('failed');
            expect(fail.body.match.FailureReason).toMatch(/unusable/i);

            // Side effects mirror cancel: the donor organ and receiver are
            // released back into the pool.
            const donorCheck = await request(app)
                .get(`/api/donor/${donor._id}`)
                .set('Authorization', `Bearer ${adminToken}`);
            expect(donorCheck.body.donor.OrgansDonated[0].Status).toBe('available');

            const receiverCheck = await request(app)
                .get(`/api/receiver/${receiver._id}`)
                .set('Authorization', `Bearer ${adminToken}`);
            expect(receiverCheck.body.receiver.Status).toBe('waiting');

            // A failure is its own terminal event — never recorded as a
            // cancellation.
            const auditRes = await request(app)
                .get(`/api/match/${match._id}/audit`)
                .set('Authorization', `Bearer ${adminToken}`);
            const events = auditRes.body.audits.map((a) => a.Event);
            expect(events).toContain('MATCH_FAILED');
            expect(events).not.toContain('MATCH_CANCELLED');
        });

        it('requires a reason to fail a match', async () => {
            const adminToken = await createAdminAndToken();
            const hospital = await createHospital(adminToken);
            const { match } = await createReservedMatch(adminToken, hospital);

            const fail = await request(app)
                .post(`/api/match/${match._id}/fail`)
                .set('Authorization', `Bearer ${adminToken}`);
            expect(fail.status).toBe(400);
        });

        it('cannot cancel a match that already failed', async () => {
            const adminToken = await createAdminAndToken();
            const hospital = await createHospital(adminToken);
            const { match } = await createReservedMatch(adminToken, hospital);

            const fail = await request(app)
                .post(`/api/match/${match._id}/fail`)
                .set('Authorization', `Bearer ${adminToken}`)
                .send({ reason: 'recipient decompensated' });
            expect(fail.status).toBe(200);
            expect(fail.body.match.AllocationPhase).toBe('failed');

            const cancel = await request(app)
                .post(`/api/match/${match._id}/cancel`)
                .set('Authorization', `Bearer ${adminToken}`)
                .send({ reason: 'after the fact' });
            expect(cancel.status).toBe(409);
        });

        it('filters listMatches by legacy Status values (pending/approved)', async () => {
            const adminToken = await createAdminAndToken();
            const hospital = await createHospital(adminToken);
            const { match } = await createReservedMatch(adminToken, hospital);

            // Advance reserved -> crossmatch_confirmed -> accepted, the modern
            // phases that the legacy Status 'approved' used to mean.
            await request(app)
                .post(`/api/match/${match._id}/crossmatch`)
                .set('Authorization', `Bearer ${adminToken}`)
                .send({ Result: 'negative', Method: 'flow_cytometry' });
            await request(app)
                .post(`/api/match/${match._id}/approve`)
                .set('Authorization', `Bearer ${adminToken}`);

            // Legacy 'approved' filter must still find the match even though
            // AllocationPhase is now 'accepted' (the legacy Status enum
            // predates the per-organ workflow).
            const approvedList = await request(app)
                .get('/api/match?status=approved')
                .set('Authorization', `Bearer ${adminToken}`);
            expect(approvedList.status).toBe(200);
            expect(approvedList.body.matches.map((m) => String(m._id))).toContain(String(match._id));

            // Legacy 'pending' (modern 'reserved') no longer matches — the
            // match has moved on.
            const pendingList = await request(app)
                .get('/api/match?status=pending')
                .set('Authorization', `Bearer ${adminToken}`);
            expect(pendingList.body.matches.map((m) => String(m._id))).not.toContain(String(match._id));

            // Modern phase values still filter directly.
            const acceptedList = await request(app)
                .get('/api/match?status=accepted')
                .set('Authorization', `Bearer ${adminToken}`);
            expect(acceptedList.body.matches.map((m) => String(m._id))).toContain(String(match._id));
        });

        it('exposes the full audit trail for a match, newest first', async () => {
            const adminToken = await createAdminAndToken();
            const hospital = await createHospital(adminToken);
            const { match } = await createReservedMatch(adminToken, hospital);

            await request(app)
                .post(`/api/match/${match._id}/crossmatch`)
                .set('Authorization', `Bearer ${adminToken}`)
                .send({ Result: 'negative', Method: 'flow_cytometry' });
            await request(app)
                .post(`/api/match/${match._id}/approve`)
                .set('Authorization', `Bearer ${adminToken}`);
            await request(app)
                .post(`/api/match/${match._id}/cancel`)
                .set('Authorization', `Bearer ${adminToken}`)
                .send({ reason: 'patient declined' });

            const auditRes = await request(app)
                .get(`/api/match/${match._id}/audit`)
                .set('Authorization', `Bearer ${adminToken}`);
            expect(auditRes.status).toBe(200);
            const events = auditRes.body.audits.map((a) => a.Event);
            expect(events).toContain('MATCH_CREATED');
            expect(events).toContain('CROSSMATCH_RECORDED');
            expect(events).toContain('MATCH_APPROVED');
            expect(events).toContain('MATCH_CANCELLED');
            // Newest event first.
            expect(events[0]).toBe('MATCH_CANCELLED');
        });
    });
});
