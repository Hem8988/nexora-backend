import { run } from './db.js';

const BASE_URL = 'http://localhost:5000/api';

async function runTests() {
  console.log("=========================================");
  console.log("         NEXORA SECURITY ENGINE TESTS     ");
  console.log("=========================================");

  try {
    // 1. Clean database for testing
    console.log("[TEST] Purging users & database transaction tables...");
    await run("DELETE FROM commissions");
    await run("DELETE FROM contracts");
    await run("DELETE FROM transactions");
    await run("DELETE FROM users");
    console.log("[SUCCESS] Database cleared.");

    // 2. Register Upline 3 (Top Level)
    console.log("\n[TEST] Registering Upline L3 (phone: +919000000003)...");
    const resL3 = await fetch(`${BASE_URL}/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: '+919000000003', password: 'password123' })
    });
    if (!resL3.ok) throw new Error(await resL3.text());
    console.log("[SUCCESS] Upline L3 Registered.");

    // Fetch referral code of L3
    // We login as L3
    const logResL3 = await fetch(`${BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: '+919000000003', password: 'password123' })
    });
    const logDataL3 = await logResL3.json();
    const tokenL3 = logDataL3.token;
    const refCodeL3 = logDataL3.user.referralCode;
    console.log(`[L3 INFO] Ref Code: ${refCodeL3}, Currency Locked: ${logDataL3.user.currency} (INR)`);

    // 3. Register Upline 2 (Level 2) referred by L3
    console.log("\n[TEST] Registering Upline L2 (phone: +919000000002) referred by L3...");
    const resL2 = await fetch(`${BASE_URL}/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: '+919000000002', password: 'password123', referredByCode: refCodeL3 })
    });
    if (!resL2.ok) throw new Error(await resL2.text());
    console.log("[SUCCESS] Upline L2 Registered.");

    // Login as L2 to get their ref code
    const logResL2 = await fetch(`${BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: '+919000000002', password: 'password123' })
    });
    const logDataL2 = await logResL2.json();
    const tokenL2 = logDataL2.token;
    const refCodeL2 = logDataL2.user.referralCode;
    console.log(`[L2 INFO] Ref Code: ${refCodeL2}`);

    // 4. Register Upline 1 (Direct Upline) referred by L2
    console.log("\n[TEST] Registering Upline L1 (phone: +919000000001) referred by L2...");
    const resL1 = await fetch(`${BASE_URL}/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: '+919000000001', password: 'password123', referredByCode: refCodeL2 })
    });
    if (!resL1.ok) throw new Error(await resL1.text());
    console.log("[SUCCESS] Upline L1 Registered.");

    // Login as L1 to get their ref code
    const logResL1 = await fetch(`${BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: '+919000000001', password: 'password123' })
    });
    const logDataL1 = await logResL1.json();
    const tokenL1 = logDataL1.token;
    const refCodeL1 = logDataL1.user.referralCode;
    console.log(`[L1 INFO] Ref Code: ${refCodeL1}`);

    // 5. Register Downline Client referred by L1
    console.log("\n[TEST] Registering Downline Investor (phone: +917000000000) referred by L1...");
    const resClient = await fetch(`${BASE_URL}/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: '+917000000000', password: 'password123', referredByCode: refCodeL1 })
    });
    if (!resClient.ok) throw new Error(await resClient.text());
    console.log("[SUCCESS] Downline Investor Registered.");

    // Login as Downline
    const logResClient = await fetch(`${BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: '+917000000000', password: 'password123' })
    });
    const logDataClient = await logResClient.json();
    const tokenClient = logDataClient.token;
    console.log(`[CLIENT INFO] Currency Locked: ${logDataClient.user.currency} (INR)`);

    // 6. Test Anti-Fraud: Submit Manual Deposit Slip twice
    console.log("\n[TEST] Submitting manual deposit of ₹10,000 via UPI (TrxID: UPI1234567)...");
    const depRes1 = await fetch(`${BASE_URL}/transact/deposit`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${tokenClient}`
      },
      body: JSON.stringify({ amount: 10000, channel: 'UPI', trxId: 'UPI1234567' })
    });
    const depData1 = await depRes1.json();
    console.log(`[RESPONSE] Status: ${depRes1.status}, Msg: ${depData1.message || depData1.error}`);

    console.log("\n[TEST] Re-submitting duplicate deposit with same TrxID (UPI1234567) to test anti-fraud block...");
    const depRes2 = await fetch(`${BASE_URL}/transact/deposit`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${tokenClient}`
      },
      body: JSON.stringify({ amount: 10000, channel: 'UPI', trxId: 'UPI1234567' })
    });
    const depData2 = await depRes2.json();
    console.log(`[RESPONSE] Status: ${depRes2.status}, Msg: ${depData2.error || depData2.message}`);
    if (depRes2.status === 400 && depData2.error.includes("already been submitted")) {
      console.log("[SUCCESS] Anti-Fraud TrxID duplicate block operates successfully!");
    } else {
      throw new Error("Anti-fraud validation failed. Duplicate TrxID accepted!");
    }

    // Login as Admin to approve deposit
    console.log("\n[TEST] Authenticating admin console session...");
    const adminLogRes = await fetch(`${BASE_URL}/auth/admin-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' })
    });
    const adminLogData = await adminLogRes.json();
    const tokenAdmin = adminLogData.token;

    // Fetch dashboard to get transaction ID
    const dashRes = await fetch(`${BASE_URL}/admin/dashboard`, {
      headers: { 'Authorization': `Bearer ${tokenAdmin}` }
    });
    const dashData = await dashRes.json();
    const pendingTx = dashData.pendingTransactions.find(t => t.trx_id === 'UPI1234567');
    console.log(`[ADMIN] Found pending transaction ID: ${pendingTx.id}`);

    // Approve transaction
    console.log("[TEST] Admin approving deposit slip...");
    const appRes = await fetch(`${BASE_URL}/admin/transactions/approve`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${tokenAdmin}`
      },
      body: JSON.stringify({ transactionId: pendingTx.id })
    });
    console.log(`[RESPONSE] Approved: ${appRes.ok}`);

    // Verify client balance
    const clientProfRes1 = await fetch(`${BASE_URL}/user/profile`, {
      headers: { 'Authorization': `Bearer ${tokenClient}` }
    });
    const clientProf1 = await clientProfRes1.json();
    console.log(`[CLIENT] Wallet Balance after deposit approval: ₹${clientProf1.balance}`);

    // 7. Purchase Contract & Verify 3-Tier Commissions
    console.log("\n[TEST] Downline client purchasing Lithium Refining contract (₹4,000)...");
    const buyRes = await fetch(`${BASE_URL}/invest/activate`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${tokenClient}`
      },
      body: JSON.stringify({ tierId: 'lithium' })
    });
    const buyData = await buyRes.json();
    console.log(`[RESPONSE] Purchase: ${buyRes.ok}, Msg: ${buyData.message}`);

    // Check balance of Client
    const clientProfRes2 = await fetch(`${BASE_URL}/user/profile`, {
      headers: { 'Authorization': `Bearer ${tokenClient}` }
    });
    const clientProf2 = await clientProfRes2.json();
    console.log(`[CLIENT] Remaining Wallet balance: ₹${clientProf2.balance} (Expected: ₹6,000)`);

    // Verify L1 commission (Direct: 10% of ₹4,000 = ₹400)
    const l1ProfRes = await fetch(`${BASE_URL}/user/profile`, {
      headers: { 'Authorization': `Bearer ${tokenL1}` }
    });
    const l1Prof = await l1ProfRes.json();
    console.log(`[UPLINE L1] Balance (expected ₹400): ₹${l1Prof.balance}`);

    // Verify L2 commission (Indirect: 4% of ₹4,000 = ₹160)
    const l2ProfRes = await fetch(`${BASE_URL}/user/profile`, {
      headers: { 'Authorization': `Bearer ${tokenL2}` }
    });
    const l2Prof = await l2ProfRes.json();
    console.log(`[UPLINE L2] Balance (expected ₹160): ₹${l2Prof.balance}`);

    // Verify L3 commission (Generational: 1% of ₹4,000 = ₹40)
    const l3ProfRes = await fetch(`${BASE_URL}/user/profile`, {
      headers: { 'Authorization': `Bearer ${tokenL3}` }
    });
    const l3Prof = await l3ProfRes.json();
    console.log(`[UPLINE L3] Balance (expected ₹40): ₹${l3Prof.balance}`);

    if (l1Prof.balance === 400 && l2Prof.balance === 160 && l3Prof.balance === 40) {
      console.log("[SUCCESS] 3-Tier instant referral commission distribution works flawlessly!");
    } else {
      throw new Error("Commission distribution calculations mismatch.");
    }

    // 8. Harvest claim checks
    console.log("\n[TEST] Loading active contract...");
    const contractRes = await fetch(`${BASE_URL}/invest/contracts`, {
      headers: { 'Authorization': `Bearer ${tokenClient}` }
    });
    const clientContracts = await contractRes.json();
    const activeContract = clientContracts[0];
    console.log(`[CONTRACT] ID: ${activeContract.id}, Project Name: ${activeContract.tier_name}`);

    console.log("[TEST] Harvesting daily reward units...");
    const claimRes1 = await fetch(`${BASE_URL}/invest/claim`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${tokenClient}`
      },
      body: JSON.stringify({ contractId: activeContract.id })
    });
    const claimData1 = await claimRes1.json();
    console.log(`[RESPONSE] Status: ${claimRes1.status}, Msg: ${claimData1.message || claimData1.error}`);

    console.log("[TEST] Submitting second harvest on same day (Must fail)...");
    const claimRes2 = await fetch(`${BASE_URL}/invest/claim`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${tokenClient}`
      },
      body: JSON.stringify({ contractId: activeContract.id })
    });
    const claimData2 = await claimRes2.json();
    console.log(`[RESPONSE] Status: ${claimRes2.status}, Msg: ${claimData2.error || claimData2.message}`);
    if (claimRes2.status === 400 && claimData2.error.includes("already collected")) {
      console.log("[SUCCESS] Double claim restriction logic operates successfully!");
    } else {
      throw new Error("Double claims validation failed.");
    }

    // 9. Vault locking constraints
    console.log("\n[TEST] Locking ₹2,000 inside the Nexora Vault...");
    const lockRes = await fetch(`${BASE_URL}/vault/lock`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${tokenClient}`
      },
      body: JSON.stringify({ amount: 2000 })
    });
    const lockData = await lockRes.json();
    console.log(`[RESPONSE] Lock Status: ${lockRes.ok}, Msg: ${lockData.message}`);

    console.log("[TEST] Attempting to unlock immediately (Must throw lock restriction)...");
    const unlockRes = await fetch(`${BASE_URL}/vault/unlock`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${tokenClient}` }
    });
    const unlockData = await unlockRes.json();
    console.log(`[RESPONSE] Unlock Status: ${unlockRes.status}, Msg: ${unlockData.error || unlockData.message}`);
    if (unlockRes.status === 400 && unlockData.error.includes("Vault is locked")) {
      console.log("[SUCCESS] Vault lock timeline security operates correctly!");
    } else {
      throw new Error("Vault unlock restriction failed.");
    }

    console.log("\n=========================================");
    console.log("    ALL CORE INTEGRATION SECURITY TESTS   ");
    console.log("            PASSED SUCCESSFULLY!          ");
    console.log("=========================================");
    process.exit(0);

  } catch (err) {
    console.error("\n❌ [FAIL] Test pipeline interrupted with error:", err.message);
    process.exit(1);
  }
}

runTests();
