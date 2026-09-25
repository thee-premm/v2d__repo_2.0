const BASE_URL = "http://localhost:5000/api/v1";

async function testAuthAndRBAC() {
  console.log("\n");
  console.log("═".repeat(60));
  console.log("        V2D AUTHENTICATION + RBAC TEST");
  console.log("═".repeat(60));

  try {
    // =====================================================
    // TEST 1 — STUDENT LOGIN
    // =====================================================

    console.log("\n🔐 TEST 1: Student Authentication");
    console.log("─".repeat(60));

    const loginResponse = await fetch(`${BASE_URL}/auth/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        username: "student_1",
        password: "StudentPass@123",
      }),
    });

    const loginData = await loginResponse.json();

    console.log(`HTTP Status: ${loginResponse.status}`);

    if (!loginResponse.ok || !loginData.success) {
      console.log("❌ Student login FAILED");
      console.log("Response:", JSON.stringify(loginData, null, 2));
      return;
    }

    const token = loginData.data?.token;
    const user = loginData.data?.user;
    const student = loginData.data?.student;

    if (!token) {
      console.log("❌ Login succeeded but JWT token is missing");
      return;
    }

    console.log("✅ Login successful");
    console.log(`   Username:    ${user.username}`);
    console.log(`   Role:        ${user.role}`);
    console.log(`   Student ID:  ${student.id}`);
    console.log(`   Roll Number: ${student.roll_number}`);
    console.log("   JWT Token:   ✅ Received");

    // =====================================================
    // TEST 2 — RBAC
    // =====================================================

    console.log("\n🛡️  TEST 2: Student RBAC");
    console.log("─".repeat(60));

    console.log("Attempting supervisor-only operation: POST /meals/slots");

    const rbacResponse = await fetch(`${BASE_URL}/meals/slots`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        meal_type_id: 4,
        slot_date: "2026-09-25",
        cutoff_time: "2026-09-25T18:00:00",
      }),
    });

    // IMPORTANT:
    // Don't assume the server returned JSON.
    // If the route doesn't exist, Express may return HTML.
    const rbacContentType = rbacResponse.headers.get("content-type") || "";

    let rbacData = null;
    let rbacText = "";

    if (rbacContentType.includes("application/json")) {
      rbacData = await rbacResponse.json();
    } else {
      rbacText = await rbacResponse.text();
    }

    console.log(`HTTP Status: ${rbacResponse.status}`);
    console.log(`Content-Type: ${rbacContentType}`);

    if (rbacData) {
      console.log("Response:", JSON.stringify(rbacData, null, 2));
    } else {
      console.log("Response:");
      console.log(rbacText);
    }

    // =====================================================
    // RBAC RESULT
    // =====================================================

    const rbacPassed = rbacResponse.status === 403;

    if (rbacPassed) {
      console.log("\n✅ RBAC PASSED");
      console.log("   Student was correctly denied access.");
    } else {
      console.log("\n❌ RBAC FAILED");
      console.log(
        `   Expected HTTP 403 but received HTTP ${rbacResponse.status}`,
      );
    }

    // =====================================================
    // FINAL SUMMARY
    // =====================================================

    const authPassed = loginResponse.ok && loginData.success && !!token;

    console.log("\n");
    console.log("═".repeat(60));
    console.log("                    TEST SUMMARY");
    console.log("═".repeat(60));

    console.log(`\n🔐 Authentication: ${authPassed ? "✅ PASS" : "❌ FAIL"}`);

    console.log(`🛡️  RBAC:          ${rbacPassed ? "✅ PASS" : "❌ FAIL"}`);

    if (authPassed && rbacPassed) {
      console.log("\n🎉 AUTH + RBAC TESTS PASSED");
      console.log("🚀 Backend security foundation is working.");
    } else {
      console.log("\n⚠️  AUTH + RBAC TESTS NOT FULLY PASSED");
    }

    console.log("\n" + "═".repeat(60));
    console.log();
  } catch (error) {
    console.error("\n❌ TEST COULD NOT COMPLETE");
    console.error("Error:", error.message);
  }
}

testAuthAndRBAC();
