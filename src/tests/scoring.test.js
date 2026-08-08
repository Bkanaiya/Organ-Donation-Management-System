// Unit tests for the scoring engine. Pure functions — no DB required.
const {
    scoreMatch,
    hlaCompatibility,
    normalizeHLA,
    proximityScore,
    meldUrgencyScore,
    ageProximityScore,
    coldIschemiaRemainingScore
} = require('../utils/scoring');
const { getOrganPolicy, POLICIES } = require('../constants/organPolicies');

// ---------------------------------------------------------------------------
// normalizeHLA
// ---------------------------------------------------------------------------

describe('normalizeHLA', () => {
    test('zero-pads single-digit alleles so serology variants compare equal', () => {
        expect(normalizeHLA('A1')).toBe('A01');
        expect(normalizeHLA('B7')).toBe('B07');
        expect(normalizeHLA('DR1')).toBe('DR01');
    });

    test('strips separators so lab and WHO formats collapse to the same key', () => {
        expect(normalizeHLA('DRB1*01:01')).toBe('DRB10101');
        expect(normalizeHLA('DRB1*0101')).toBe('DRB10101');
        expect(normalizeHLA('A*02:01')).toBe('A0201');
    });

    test('uppercases and strips whitespace', () => {
        expect(normalizeHLA(' a1 ')).toBe('A01');
    });

    test('non-string input yields an empty string', () => {
        expect(normalizeHLA(null)).toBe('');
    });
});

// ---------------------------------------------------------------------------
// hlaCompatibility
// ---------------------------------------------------------------------------

describe('hlaCompatibility', () => {
    const cfg = { loci: ['A', 'B', 'DR'], locusWeights: { A: 0.2, B: 0.3, DR: 0.5 } };

    test('full 6/6 match scores 100', () => {
        const donor = { HLA_Typing: { A: ['A1', 'A2'], B: ['B7', 'B8'], DR: ['DR1', 'DR4'] } };
        const receiver = { HLA_Typing: { A: ['A1', 'A2'], B: ['B7', 'B8'], DR: ['DR1', 'DR4'] } };
        const compat = hlaCompatibility(donor, null, receiver, cfg);
        expect(compat).not.toBeNull();
        expect(compat.score).toBe(100);
        expect(compat.matches).toBe(6);
        expect(compat.expected).toBe(6);
    });

    test('zero match scores 0', () => {
        const donor = { HLA_Typing: { A: ['A1', 'A2'], B: ['B7', 'B8'], DR: ['DR1', 'DR4'] } };
        const receiver = { HLA_Typing: { A: ['A3', 'A11'], B: ['B27', 'B44'], DR: ['DR7', 'DR15'] } };
        expect(hlaCompatibility(donor, null, receiver, cfg).score).toBe(0);
    });

    test('DR match counts for more than an A match (weights)', () => {
        const donor = { HLA_Typing: { A: ['A1', 'A2'], B: ['B7', 'B8'], DR: ['DR1', 'DR4'] } };

        // Receiver shares only the DR locus -> higher than sharing only A.
        const drOnly = { HLA_Typing: { A: ['A3', 'A11'], B: ['B27', 'B44'], DR: ['DR1', 'DR4'] } };
        const aOnly = { HLA_Typing: { A: ['A1', 'A2'], B: ['B27', 'B44'], DR: ['DR7', 'DR15'] } };

        expect(hlaCompatibility(donor, null, drOnly, cfg).score)
            .toBeGreaterThan(hlaCompatibility(donor, null, aOnly, cfg).score);
    });

    test('a single typed allele can match at most 50% of its locus (no sparse inflation)', () => {
        const donor = { HLA_Typing: { A: ['A1', 'A2'], B: ['B7', 'B8'], DR: ['DR1', 'DR4'] } };
        // Receiver typed with only one A allele that matches.
        const sparse = { HLA_Typing: { A: ['A1'], B: ['B7', 'B8'], DR: ['DR1', 'DR4'] } };
        const compat = hlaCompatibility(donor, null, sparse, cfg);
        expect(compat.perLocus.A).toBe(50);   // 1/2, not 1/1
        expect(compat.score).toBeLessThan(100);
    });

    test('untyped locus returns null (not applicable), never 0', () => {
        const donor = { HLA_Typing: { A: ['A1', 'A2'], B: ['B7', 'B8'] } };   // no DR
        const receiver = { HLA_Typing: { A: ['A1', 'A2'], B: ['B7', 'B8'], DR: ['DR1', 'DR4'] } };
        expect(hlaCompatibility(donor, null, receiver, cfg)).toBeNull();
    });

    test('organ-entry HLA typing takes precedence over donor-level typing', () => {
        const donor = { HLA_Typing: { A: ['A1', 'A2'], B: ['B7', 'B8'], DR: ['DR1', 'DR4'] } };
        const organEntry = { HLA_Typing: { A: ['A3', 'A11'], B: ['B27', 'B44'], DR: ['DR7', 'DR15'] } };
        const receiver = { HLA_Typing: { A: ['A3', 'A11'], B: ['B27', 'B44'], DR: ['DR7', 'DR15'] } };
        const compat = hlaCompatibility(donor, organEntry, receiver, cfg);
        expect(compat.score).toBe(100);
    });

    test('homozygous donor duplicate counts once but earns FULL credit (A1,A1 vs A1,A2 -> 1 match, 100 on A)', () => {
        const donor = { HLA_Typing: { A: ['A1', 'A1'], B: ['B7', 'B8'], DR: ['DR1', 'DR4'] } };
        const receiver = { HLA_Typing: { A: ['A1', 'A2'], B: ['B7', 'B8'], DR: ['DR1', 'DR4'] } };
        const compat = hlaCompatibility(donor, null, receiver, cfg);
        // The duplicate A1 counts ONCE (no inflation), but it is the donor's
        // only A antigen — matched, so the locus gets full credit (1/1, not
        // 1/2). The 6/6 gate is about the antigens the donor actually
        // carries, and this donor carries A1, B7, B8, DR1, DR4 = all matched.
        expect(compat.perLocus.A).toBe(100);
        expect(compat.matches).toBe(5);       // A contributes 1, B and DR contribute 2 each
        expect(compat.expected).toBe(5);      // A contributes 1 slot, B and DR 2 each
        expect(compat.score).toBe(100);
    });

    test('a homozygous donor whose one allele does NOT match scores 0 on that locus', () => {
        const donor = { HLA_Typing: { A: ['A1', 'A1'], B: ['B7', 'B8'], DR: ['DR1', 'DR4'] } };
        const receiver = { HLA_Typing: { A: ['A3', 'A11'], B: ['B7', 'B8'], DR: ['DR1', 'DR4'] } };
        const compat = hlaCompatibility(donor, null, receiver, cfg);
        expect(compat.perLocus.A).toBe(0);
        expect(compat.matches).toBe(4);       // B and DR only
        expect(compat.score).toBeLessThan(100);
    });

    test('a fully-homozygous donor matched on all three loci now clears the marrow gate (3 real antigens, not 6)', () => {
        const marrowCfg = { loci: ['A', 'B', 'DR'], locusWeights: { A: 0.2, B: 0.3, DR: 0.5 } };
        const donor = { HLA_Typing: { A: ['A1', 'A1'], B: ['B7', 'B7'], DR: ['DR1', 'DR1'] } };
        const receiver = { HLA_Typing: { A: ['A1', 'A2'], B: ['B7', 'B8'], DR: ['DR1', 'DR4'] } };
        const compat = hlaCompatibility(donor, null, receiver, marrowCfg);
        // The homozygote's three distinct antigens are ALL present in the
        // receiver, so every locus is fully matched. expected reflects the
        // donor's real antigen load (3, not 6) — the score reaches 100 and
        // marrow's minHlaScore 100 is attainable for a homozygote.
        expect(compat.matches).toBe(3);
        expect(compat.expected).toBe(3);
        expect(compat.score).toBe(100);
    });

    test('a fully-homozygous donor with any locus mismatched stays below the marrow gate', () => {
        const marrowCfg = { loci: ['A', 'B', 'DR'], locusWeights: { A: 0.2, B: 0.3, DR: 0.5 } };
        const donor = { HLA_Typing: { A: ['A1', 'A1'], B: ['B7', 'B7'], DR: ['DR1', 'DR1'] } };
        const receiver = { HLA_Typing: { A: ['A1', 'A2'], B: ['B8', 'B44'], DR: ['DR1', 'DR4'] } };   // B mismatched
        const compat = hlaCompatibility(donor, null, receiver, marrowCfg);
        expect(compat.perLocus.B).toBe(0);
        expect(compat.score).toBeLessThan(100);
    });

    test('normalized comparison — formatting differences do not hide a match', () => {
        const donor = { HLA_Typing: { A: ['A*02:01', 'A*24:02'], B: ['B*07:02', 'B*08:01'], DR: ['DRB1*04:01', 'DRB1*15:01'] } };
        const receiver = { HLA_Typing: { A: ['A0201', 'A2402'], B: ['B0702', 'B0801'], DR: ['DRB10401', 'DRB11501'] } };
        expect(hlaCompatibility(donor, null, receiver, cfg).score).toBe(100);
    });
});

// ---------------------------------------------------------------------------
// Medical urgency
// ---------------------------------------------------------------------------

describe('meldUrgencyScore', () => {
    test('piecewise mapping: low MELD maps flat, high MELD steep', () => {
        expect(meldUrgencyScore({})).toBe(0);
        expect(meldUrgencyScore({ MELD_score: 20 })).toBe(50);
        expect(meldUrgencyScore({ MELD_score: 30 })).toBe(75);
        expect(meldUrgencyScore({ MELD_score: 40 })).toBe(100);
    });

    test('exception points raise urgency but effective MELD caps at 40', () => {
        const withException = meldUrgencyScore({ MELD_score: 25, MELD_ExceptionPoints: 10 });
        expect(withException).toBeGreaterThan(meldUrgencyScore({ MELD_score: 25 }));
        // 25 + 34 = 59 -> clamped to 40 -> 100.
        expect(meldUrgencyScore({ MELD_score: 25, MELD_ExceptionPoints: 34 })).toBe(100);
    });
});

// ---------------------------------------------------------------------------
// Location
// ---------------------------------------------------------------------------

describe('proximityScore', () => {
    test('same-district heart donor scores high; cross-state scores near zero', () => {
        const heartPolicy = getOrganPolicy('Heart');
        const sameDistrict = proximityScore(
            { State: 'Kerala', District: 'TVM' },
            { State: 'Kerala', District: 'TVM' },
            heartPolicy
        );
        const crossState = proximityScore(
            { State: 'Kerala', District: 'TVM' },
            { State: 'Delhi', District: 'Central' },
            heartPolicy
        );
        expect(sameDistrict).toBeGreaterThan(crossState);
        expect(sameDistrict).toBeGreaterThan(70);
    });

    test('cornea (huge ischemia budget) barely penalizes cross-state distance', () => {
        const corneaPolicy = getOrganPolicy('Cornea');
        const crossState = proximityScore(
            { State: 'Kerala', District: 'TVM' },
            { State: 'Delhi', District: 'Central' },
            corneaPolicy
        );
        // e^{-1200/1250} ~= 0.38 -> 38; clearly above the heart's ~8.
        expect(crossState).toBeGreaterThan(30);
    });
});

// ---------------------------------------------------------------------------
// Age
// ---------------------------------------------------------------------------

describe('ageProximityScore', () => {
    test('ideal-age donor scores 100, donors at the age cap score 0', () => {
        const kidney = getOrganPolicy('Kidney');
        expect(ageProximityScore({ Age: 30 }, { Age: 50 }, kidney)).toBe(100);
        expect(ageProximityScore({ Age: 75 }, { Age: 50 }, kidney)).toBe(0);
    });

    test('heart penalizes a large donor-receiver age gap', () => {
        const heart = getOrganPolicy('Heart');
        const wideGap = ageProximityScore({ Age: 55 }, { Age: 20 }, heart);
        const closeGap = ageProximityScore({ Age: 40 }, { Age: 38 }, heart);
        expect(wideGap).toBeLessThan(closeGap);
    });
});

// ---------------------------------------------------------------------------
// Cold ischemia
// ---------------------------------------------------------------------------

describe('coldIschemiaRemainingScore', () => {
    test('freshly-procured kidney scores high, near-threshold scores ~0', () => {
        const kidney = getOrganPolicy('Kidney');   // 1440 min limit, 60 min threshold
        const now = new Date('2026-01-10T00:00:00Z');
        const fresh = { IschemiaStartedAt: new Date('2026-01-09T22:00:00Z') };   // 2h ago
        const nearExpiry = { IschemiaStartedAt: new Date('2026-01-09T00:00:00Z') }; // procured 24h ago
        expect(coldIschemiaRemainingScore(fresh, kidney, now))
            .toBeGreaterThan(coldIschemiaRemainingScore(nearExpiry, kidney, now));
    });

    test('no ischemia budget (marrow) or unprocured organ scores 100', () => {
        const marrow = getOrganPolicy('Bone Marrow');
        expect(coldIschemiaRemainingScore({}, marrow, new Date())).toBe(100);
        expect(coldIschemiaRemainingScore(null, getOrganPolicy('Kidney'), new Date())).toBe(100);
    });
});

// ---------------------------------------------------------------------------
// Waiting-time caps — every policy must declare one
// ---------------------------------------------------------------------------

describe('waitingTimeCapDays', () => {
    test('every organ policy declares a positive numeric cap so no factor falls back to a hidden default', () => {
        for (const [organ, factory] of Object.entries(POLICIES)) {
            const policy = factory();
            expect(Number.isFinite(policy.waitingTimeCapDays)).toBe(true);
            expect(policy.waitingTimeCapDays).toBeGreaterThan(0);
        }
    });
});

// ---------------------------------------------------------------------------
// scoreMatch — composition and renormalization
// ---------------------------------------------------------------------------

describe('scoreMatch', () => {
    const donor = {
        _id: 'd1',
        Age: 32,
        State: 'Kerala',
        District: 'TVM',
        BloodGroup: 'O+',
        HLA_Typing: { A: ['A1', 'A2'], B: ['B7', 'B8'], DR: ['DR1', 'DR4'] }
    };
    const receiver = {
        _id: 'r1',
        Age: 45,
        State: 'Kerala',
        District: 'TVM',
        BloodGroup: 'O+',
        Urgency: 'critical',
        WaitlistDate: new Date('2025-01-10T00:00:00Z'),
        HLA_Typing: { A: ['A1', 'A2'], B: ['B7', 'B8'], DR: ['DR1', 'DR4'] },
        MinOrganWeight_grams: 100,
        MaxOrganWeight_grams: 300
    };
    const now = new Date('2026-01-10T00:00:00Z');

    test('total is 0..100 and all factor keys appear in the breakdown', () => {
        const kidney = getOrganPolicy('Kidney');
        const organEntry = { Organ: 'Kidney', IsPediatric: false, OrganWeight_grams: 200 };
        const { total, breakdown } = scoreMatch(donor, organEntry, receiver, 'Kidney', kidney, now);
        expect(total).toBeGreaterThanOrEqual(0);
        expect(total).toBeLessThanOrEqual(100);
        for (const key of ['location', 'urgency', 'waitingTime', 'ageProximity', 'pediatricPriority', 'sizeMatch', 'hlaMatch', 'coldIschemiaRemaining']) {
            expect(breakdown).toHaveProperty(key);
        }
        expect(breakdown.policyVersion).toBe(kidney.version);
        expect(breakdown.weights).toEqual(kidney.scoreWeights);
    });

    test('liver ignores HLA (hlaMatch null) and renormalizes the weights', () => {
        const liver = getOrganPolicy('Liver');
        const { breakdown, total } = scoreMatch(donor, { Organ: 'Liver', IsPediatric: false }, receiver, 'Liver', liver, now);
        expect(breakdown.hlaMatch).toBeNull();
        // With a null factor dropped, the rest still sum to a 0..100 total.
        expect(total).toBeGreaterThanOrEqual(0);
        expect(total).toBeLessThanOrEqual(100);
        expect(breakdown.factors.daysWaiting).toBe(365);
    });

    test('MELD urgency drives liver score when MELD_score is present', () => {
        const liver = getOrganPolicy('Liver');
        const highMeld = { ...receiver, MELD_score: 38 };
        const lowMeld = { ...receiver, MELD_score: 8 };
        const a = scoreMatch(donor, { Organ: 'Liver', IsPediatric: false }, highMeld, 'Liver', liver, now);
        const b = scoreMatch(donor, { Organ: 'Liver', IsPediatric: false }, lowMeld, 'Liver', liver, now);
        expect(a.breakdown.urgency).toBeGreaterThan(b.breakdown.urgency);
    });

    test('heart status tier drives urgency; a receiver without a tier fails closed to 0, even Urgency critical', () => {
        const heart = getOrganPolicy('Heart');
        const tiered = { ...receiver, HeartStatus: 1 };
        const untiered = { ...receiver, Urgency: 'critical' };   // no tier -> cannot substantiate urgency
        const a = scoreMatch(donor, { Organ: 'Heart', IsPediatric: false }, tiered, 'Heart', heart, now);
        const b = scoreMatch(donor, { Organ: 'Heart', IsPediatric: false }, untiered, 'Heart', heart, now);
        expect(a.breakdown.urgency).toBe(100);
        expect(b.breakdown.urgency).toBe(0);
        expect(a.breakdown.urgency).toBeGreaterThan(b.breakdown.urgency);
    });

    test('liver urgency is MELD-driven only — a critical receiver without MELD does not outrank a sick one', () => {
        const liver = getOrganPolicy('Liver');
        const sick = { ...receiver, MELD_score: 35 };              // 87.5
        const undocumented = { ...receiver, Urgency: 'critical' }; // no MELD -> 0
        const a = scoreMatch(donor, { Organ: 'Liver', IsPediatric: false }, sick, 'Liver', liver, now);
        const b = scoreMatch(donor, { Organ: 'Liver', IsPediatric: false }, undocumented, 'Liver', liver, now);
        expect(a.breakdown.urgency).toBe(88);
        expect(b.breakdown.urgency).toBe(0);
        expect(a.breakdown.urgency).toBeGreaterThan(b.breakdown.urgency);
    });

    test('pediatric receiver gets a full 100 on pediatricPriority', () => {
        const kidney = getOrganPolicy('Kidney');
        const child = { ...receiver, Age: 10 };
        const { breakdown } = scoreMatch(donor, { Organ: 'Kidney', IsPediatric: false }, child, 'Kidney', kidney, now);
        expect(breakdown.pediatricPriority).toBe(100);
    });

    test('waiting time increases with days on the list, capped by the policy', () => {
        const kidney = getOrganPolicy('Kidney');   // cap 1095 days
        const longWait = { ...receiver, WaitlistDate: new Date('2020-01-10T00:00:00Z') };   // ~2190d -> capped 100
        const shortWait = { ...receiver, WaitlistDate: new Date('2025-12-10T00:00:00Z') };   // ~30d
        const a = scoreMatch(donor, { Organ: 'Kidney', IsPediatric: false }, longWait, 'Kidney', kidney, now);
        const b = scoreMatch(donor, { Organ: 'Kidney', IsPediatric: false }, shortWait, 'Kidney', kidney, now);
        expect(a.breakdown.waitingTime).toBe(100);
        expect(b.breakdown.waitingTime).toBeLessThan(20);
    });
});
