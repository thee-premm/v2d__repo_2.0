import { env } from '../src/config/env.js';

const BASE_URL = `http://localhost:${env.PORT}/api/v1`;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const logSection = (title) => {
  console.log(`\n==============================================================================`);
  console.log(`  ${title}`);
  console.log(`==============================================================================`);
};

async function runDemo() {
  console.log(`\n🚀 Starting Automated Proof of Work (PoW) Demo Runner...`);
  console.log(`   Target Server: ${BASE_URL}\n`);

  try {
    // -------------------------------------------------------------------------
    // STEP 1: RBAC ISOLATION TEST
    // -------------------------------------------------------------------------
    logSection(`STEP 1: RBAC Isolation & Auth Claims Test`);

    // Login Student 1
    const student1LoginRes = await fetch(`${BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'student_1', password: 'StudentPass@123' }),
    });
    const student1LoginData = await student1LoginRes.json();
    if (!student1LoginData.success) {
      throw new Error(`Student 1 login failed: ${student1LoginData.message}`);
    }
    const student1Token = student1LoginData.data.token;
    console.log(`✓ Student 1 Logged in successfully. Token acquired.`);

    // Student attempts to create a meal slot (Unauthorized)
    const illegalSlotRes = await fetch(`${BASE_URL}/meals/slots`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${student1Token}`,
      },
      body: JSON.stringify({
        mess_id: 1,
        meal_type_id: 4,
        slot_date: new Date().toISOString().split('T')[0],
        open_time: new Date().toISOString(),
        cutoff_time: new Date(Date.now() + 60000).toISOString(),
        meal_start_time: new Date(Date.now() + 120000).toISOString(),
        meal_end_time: new Date(Date.now() + 3600000).toISOString(),
      }),
    });
    const illegalSlotData = await illegalSlotRes.json();
    if (illegalSlotRes.status === 403) {
      console.log(`✅ [PASSED] RBAC Isolation Guard: Student slot creation rejected with status 403 Forbidden.`);
      console.log(`   Response Message: "${illegalSlotData.message}"`);
    } else {
      throw new Error(`RBAC Failure! Student was allowed to create slot. Status: ${illegalSlotRes.status}`);
    }

    // -------------------------------------------------------------------------
    // STEP 2: SUPERVISOR SLOT CREATION
    // -------------------------------------------------------------------------
    logSection(`STEP 2: Supervisor Slot Scheduling (4-Second Cutoff Window)`);

    // Login Supervisor
    const supLoginRes = await fetch(`${BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'supervisor_kaveri', password: 'SuperPass@123' }),
    });
    const supLoginData = await supLoginRes.json();
    if (!supLoginData.success) {
      throw new Error(`Supervisor login failed: ${supLoginData.message}`);
    }
    const supervisorToken = supLoginData.data.token;
    const supervisorMessId = supLoginData.data.student?.mess_id || 1;
    console.log(`✓ Supervisor logged in successfully. Mess ID: ${supervisorMessId}`);

    // Schedule DINNER slot opening NOW with 4-Second Cutoff Window
    const now = Date.now();
    const openTime = new Date(now - 1000).toISOString();
    const cutoffTime = new Date(now + 4000).toISOString(); // 4 seconds from now
    const mealStartTime = new Date(now + 10000).toISOString();
    const mealEndTime = new Date(now + 3600000).toISOString();

    const createSlotRes = await fetch(`${BASE_URL}/meals/slots`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${supervisorToken}`,
      },
      body: JSON.stringify({
        mess_id: supervisorMessId,
        meal_type_id: 4, // DINNER
        slot_date: new Date().toISOString().split('T')[0],
        open_time: openTime,
        cutoff_time: cutoffTime,
        meal_start_time: mealStartTime,
        meal_end_time: mealEndTime,
      }),
    });

    const createSlotData = await createSlotRes.json();
    if (!createSlotData.success) {
      throw new Error(`Slot creation failed: ${createSlotData.message}`);
    }
    const createdSlot = createSlotData.data;
    console.log(`✅ [PASSED] Supervisor created DINNER Meal Slot (ID: ${createdSlot.id}).`);
    console.log(`   Open Time:   ${createdSlot.open_time}`);
    console.log(`   Cutoff Time: ${createdSlot.cutoff_time} (Strict 4s Window)`);

    // -------------------------------------------------------------------------
    // STEP 3: MULTI-STUDENT HIGH-THROUGHPUT VOTE INGESTION
    // -------------------------------------------------------------------------
    logSection(`STEP 3: Dynamic Multi-Student Vote Ingestion`);

    const studentTokens = {};
    for (let i = 1; i <= 10; i++) {
      const sLogin = await fetch(`${BASE_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: `student_${i}`, password: 'StudentPass@123' }),
      });
      const sData = await sLogin.json();
      studentTokens[i] = sData.data.token;
    }

    // Students 1..6 vote YES
    for (let i = 1; i <= 6; i++) {
      const res = await fetch(`${BASE_URL}/votes/cast`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${studentTokens[i]}`,
        },
        body: JSON.stringify({ meal_slot_id: createdSlot.id, vote_status: true }),
      });
      const data = await res.json();
      console.log(`  - Student ${i} voted YES: ${data.success ? 'Success' : data.message}`);
    }

    // Students 7 and 8 vote NO
    for (let i = 7; i <= 8; i++) {
      const res = await fetch(`${BASE_URL}/votes/cast`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${studentTokens[i]}`,
        },
        body: JSON.stringify({ meal_slot_id: createdSlot.id, vote_status: false }),
      });
      const data = await res.json();
      console.log(`  - Student ${i} voted NO: ${data.success ? 'Success' : data.message}`);
    }

    // Student 9 votes NO, then flips vote to YES (Idempotency check)
    await fetch(`${BASE_URL}/votes/cast`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${studentTokens[9]}`,
      },
      body: JSON.stringify({ meal_slot_id: createdSlot.id, vote_status: false }),
    });
    const flipRes = await fetch(`${BASE_URL}/votes/cast`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${studentTokens[9]}`,
      },
      body: JSON.stringify({ meal_slot_id: createdSlot.id, vote_status: true }),
    });
    const flipData = await flipRes.json();
    console.log(`  - Student 9 flipped vote (NO -> YES): ${flipData.success ? 'Success' : flipData.message}`);

    console.log(`  - Student 10 did not submit a vote (Simulating No Response)`);
    console.log(`✅ [PASSED] Ingested votes for 9 active students before cutoff.`);

    // -------------------------------------------------------------------------
    // STEP 4: CUTOFF EXPIRATION & LOCK ENFORCEMENT TEST
    // -------------------------------------------------------------------------
    logSection(`STEP 4: Cutoff Window Expiration Test`);
    console.log(`⏳ Waiting 5 seconds for voting window to expire past cutoff...`);
    await delay(5000);

    const lateVoteRes = await fetch(`${BASE_URL}/votes/cast`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${studentTokens[10]}`,
      },
      body: JSON.stringify({ meal_slot_id: createdSlot.id, vote_status: true }),
    });
    const lateVoteData = await lateVoteRes.json();
    if (lateVoteRes.status === 403) {
      console.log(`✅ [PASSED] Cutoff Enforcement: Late vote past cutoff rejected with status 403 Forbidden.`);
      console.log(`   Response Message: "${lateVoteData.message}"`);
    } else {
      throw new Error(`Cutoff failure! Late vote was accepted past cutoff window. Status: ${lateVoteRes.status}`);
    }

    // -------------------------------------------------------------------------
    // STEP 5: DEMAND SIGNAL AGGREGATION
    // -------------------------------------------------------------------------
    logSection(`STEP 5: Cutoff Lock & Demand Signal Aggregation`);

    const aggRes = await fetch(`${BASE_URL}/meals/${createdSlot.id}/cutoff-aggregate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${supervisorToken}`,
      },
    });
    const aggData = await aggRes.json();
    if (!aggData.success) {
      throw new Error(`Cutoff aggregation failed: ${aggData.message}`);
    }

    const agg = aggData.data.aggregate;
    console.log(`✅ [PASSED] Demand Signal Aggregated Successfully:`);
    console.log(`   Total Enrolled:      ${agg.total_enrolled}`);
    console.log(`   YES Votes:           ${agg.yes_votes}`);
    console.log(`   NO Votes:            ${agg.no_votes}`);
    console.log(`   No Response Count:   ${agg.no_response_count}`);
    console.log(`   Expected Attendance: ${agg.expected_attendance}`);

    if (agg.yes_votes !== 7 || agg.no_votes !== 2 || agg.no_response_count !== 1) {
      throw new Error(`Aggregation mismatch! Expected 7 YES, 2 NO, 1 No Response. Got: ${JSON.stringify(agg)}`);
    }

    // -------------------------------------------------------------------------
    // STEP 6: PHYSICAL COUNTER VERIFICATION GATE (3-WAY CLASSIFICATION)
    // -------------------------------------------------------------------------
    logSection(`STEP 6: Counter Verification Gate (3-Way Classification)`);

    // Student 1 (Voted YES) -> Expect PRESENT
    const v1Res = await fetch(`${BASE_URL}/attendance/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${supervisorToken}`,
      },
      body: JSON.stringify({ roll_number: '2026IT0001', meal_slot_id: createdSlot.id }),
    });
    const v1Data = await v1Res.json();
    console.log(`  - Student 1 Scan: Classified as [${v1Data.data.classification}] (Expected: PRESENT)`);

    // Student 7 (Voted NO) -> Expect EXCUSED_OVERRIDE (Authorized Walk-In)
    const v7Res = await fetch(`${BASE_URL}/attendance/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${supervisorToken}`,
      },
      body: JSON.stringify({ roll_number: '2026IT0007', meal_slot_id: createdSlot.id }),
    });
    const v7Data = await v7Res.json();
    console.log(`  - Student 7 Scan: Classified as [${v7Data.data.classification}] (Expected: EXCUSED_OVERRIDE)`);

    // Student 10 (No Response) -> Expect UNVOTED_WALK_IN (Mess Policy Walk-In)
    const v10Res = await fetch(`${BASE_URL}/attendance/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${supervisorToken}`,
      },
      body: JSON.stringify({ roll_number: '2026IT0010', meal_slot_id: createdSlot.id }),
    });
    const v10Data = await v10Res.json();
    console.log(`  - Student 10 Scan: Classified as [${v10Data.data.classification}] (Expected: UNVOTED_WALK_IN)`);

    if (
      v1Data.data.classification !== 'PRESENT' ||
      v7Data.data.classification !== 'EXCUSED_OVERRIDE' ||
      v10Data.data.classification !== 'UNVOTED_WALK_IN'
    ) {
      throw new Error(`3-Way Classification Gate failed state evaluation!`);
    }

    console.log(`✅ [PASSED] 3-Way Counter Verification Gate executed with 100% classification accuracy.`);

    // -------------------------------------------------------------------------
    // STEP 7: NO-SHOW RECONCILER & ACCOUNTABILITY ENGINE
    // -------------------------------------------------------------------------
    logSection(`STEP 7: Post-Meal No-Show Reconciler Execution`);

    const reconRes = await fetch(`${BASE_URL}/exceptions/reconcile-no-shows/${createdSlot.id}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${supervisorToken}`,
      },
    });
    const reconData = await reconRes.json();
    if (!reconData.success) {
      throw new Error(`Reconciliation failed: ${reconData.message}`);
    }

    console.log(`✅ [PASSED] Reconciled No-Shows: ${reconData.data.reconciled_count} unverified YES voters marked ABSENT.`);
    reconData.data.absent_records.forEach((rec) => {
      console.log(`   - Student ${rec.name} (${rec.roll_number}) marked ABSENT -> Warning Tier ${rec.warning_tier} Issued.`);
    });

    // -------------------------------------------------------------------------
    // STEP 8: FINAL SUMMARY REPORT
    // -------------------------------------------------------------------------
    logSection(`STEP 8: Final Intention vs. Reality Summary Report`);

    const summaryTable = [
      { Metric: 'Total Enrolled Students', Count: agg.total_enrolled, Category: 'System Baseline' },
      { Metric: 'Declared YES Intentions', Count: agg.yes_votes, Category: 'Demand Signal' },
      { Metric: 'Declared NO Intentions', Count: agg.no_votes, Category: 'Demand Signal' },
      { Metric: 'No Response / Unvoted', Count: agg.no_response_count, Category: 'Demand Signal' },
      { Metric: 'Verified PRESENT (YES + Attended)', Count: 1, Category: 'Physical Reality' },
      { Metric: 'Verified EXCUSED_OVERRIDE (NO + Attended)', Count: 1, Category: 'Physical Reality' },
      { Metric: 'Verified UNVOTED_WALK_IN (None + Attended)', Count: 1, Category: 'Physical Reality' },
      { Metric: 'Reconciled ABSENT (YES + Missing)', Count: reconData.data.reconciled_count, Category: 'Ground-Truth Deviation' },
    ];

    console.table(summaryTable);
    console.log(`\n🎉 PROOF OF WORK SIMULATION COMPLETE: ALL CORE MECHANICS VERIFIED 100% PASS!\n`);

  } catch (error) {
    console.error(`\n❌ PROOF OF WORK DEMO FAILED:`, error.message);
    process.exit(1);
  }
}

runDemo();
