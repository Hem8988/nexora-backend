import { run, get } from './db.js';

const BASE_URL = 'http://localhost:5000/api';

async function runTests() {
  console.log("=========================================");
  console.log("     NEXORA TRIPLE-WALLET SYSTEM TESTS   ");
  console.log("=========================================");

  try {
    // 1. Clear DB
    console.log("[TEST] Purging users, contracts, commissions, vault_locks & transactions tables...");
    await run("DELETE FROM commissions");
    await run("DELETE FROM contracts");
    await run("DELETE FROM transactions");
    await run("DELETE FROM vault_locks");
    await run("DELETE FROM users");
    console.log("[SUCCESS] Database cleared.");

    // 2. Register Upline L2
    console.log("\n[TEST] Registering Upline L2 (phone: +8801700000002)...");
    const resL2 = await fetch(`${BASE_URL}/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: '+8801700000002', password: 'password123' })
    });
    if (!resL2.ok) throw new Error(await resL2.text());

    // Login as L2 to get ref code
    const logResL2 = await fetch(`${BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: '+8801700000002', password: 'password123' })
    });
    const logDataL2 = await logResL2.json();
    const tokenL2 = logDataL2.token;
    const refCodeL2 = logDataL2.user.referralCode;
    console.log(`[L2 INFO] Ref Code: ${refCodeL2}, Currency: ${logDataL2.user.currency}`);

    // 3. Register Upline L1 referred by L2
    console.log("\n[TEST] Registering Upline L1 (phone: +8801700000001) referred by L2...");
    const resL1 = await fetch(`${BASE_URL}/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: '+8801700000001', password: 'password123', referredByCode: refCodeL2 })
    });
    if (!resL1.ok) throw new Error(await resL1.text());

    // Login as L1 to get ref code
    const logResL1 = await fetch(`${BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: '+8801700000001', password: 'password123' })
    });
    const logDataL1 = await logResL1.json();
    const tokenL1 = logDataL1.token;
    const refCodeL1 = logDataL1.user.referralCode;
    console.log(`[L1 INFO] Ref Code: ${refCodeL1}`);

    // 4. Register Downline Client referred by L1
    console.log("\n[TEST] Registering Downline Client (phone: +8801700000000) referred by L1...");
    const resClient = await fetch(`${BASE_URL}/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: '+8801700000000', password: 'password123', referredByCode: refCodeL1 })
    });
    if (!resClient.ok) throw new Error(await resClient.text());

    // Login as client
    const logResClient = await fetch(`${BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: '+8801700000000', password: 'password123' })
    });
    const logDataClient = await logResClient.json();
    const tokenClient = logDataClient.token;
    console.log(`[CLIENT INFO] Connected.`);

    // 5. Submit deposit slip
    console.log("\n[TEST] Client submitting manual deposit of ৳10,000 via bKash...");
    const depRes = await fetch(`${BASE_URL}/transact/deposit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${tokenClient}`
      },
      body: JSON.stringify({ amount: 10000, channel: 'bKash', trxId: 'BKASH-DEPOSIT-10K' })
    });
    const depData = await depRes.json();
    console.log(`[RESPONSE] Deposit Submission status: ${depRes.status}, Msg: ${depData.message}`);

    // 6. Admin clears deposit
    console.log("\n[TEST] Admin connecting and clearing deposit transaction...");
    const adminLogRes = await fetch(`${BASE_URL}/auth/admin-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' })
    });
    const adminLogData = await adminLogRes.json();
    const tokenAdmin = adminLogData.token;

    // Get pending transactions
    const adminDashRes = await fetch(`${BASE_URL}/admin/dashboard`, {
      headers: { 'Authorization': `Bearer ${tokenAdmin}` }
    });
    const adminDash = await adminDashRes.json();
    const pendingTx = adminDash.pendingTransactions.find(t => t.trx_id === 'BKASH-DEPOSIT-10K');
    console.log(`[ADMIN] Pending TRX ID: ${pendingTx.id}`);

    // Approve TRX
    const appRes = await fetch(`${BASE_URL}/admin/transactions/approve`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${tokenAdmin}`
      },
      body: JSON.stringify({ transactionId: pendingTx.id })
    });
    console.log(`[RESPONSE] Admin Approve status: ${appRes.status}`);

    // Verify Client Triple-wallet balance
    const clientProfRes1 = await fetch(`${BASE_URL}/user/profile`, {
      headers: { 'Authorization': `Bearer ${tokenClient}` }
    });
    const clientProf1 = await clientProfRes1.json();
    console.log(`[CLIENT PROFILE] Balance: ৳${clientProf1.balance}, Deposit Bal: ৳${clientProf1.deposit_balance}, Comm Bal: ৳${clientProf1.commission_balance}`);
    if (clientProf1.deposit_balance !== 10000) {
      throw new Error(`Deposit balance was not credited properly. Expected 10000, got ${clientProf1.deposit_balance}`);
    }
    console.log("[SUCCESS] Triple wallet deposit loading verified.");

    // 7. Client leases project (৳5,000 Wind Turbine tier)
    console.log("\n[TEST] Client leasing Wind Turbine Project (৳5,000)...");
    const leaseRes = await fetch(`${BASE_URL}/invest/activate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${tokenClient}`
      },
      body: JSON.stringify({ tierId: 'wind' })
    });
    const leaseData = await leaseRes.json();
    console.log(`[RESPONSE] Lease Activation: ${leaseRes.status}, Msg: ${leaseData.message}`);

    // Check balances
    const clientProfRes2 = await fetch(`${BASE_URL}/user/profile`, {
      headers: { 'Authorization': `Bearer ${tokenClient}` }
    });
    const clientProf2 = await clientProfRes2.json();
    console.log(`[CLIENT PROFILE] Balance: ৳${clientProf2.balance}, Deposit Bal: ৳${clientProf2.deposit_balance} (Expected: ৳5,000)`);
    if (clientProf2.deposit_balance !== 5000) {
      throw new Error(`Deposit balance was not deducted correctly. Expected 5000, got ${clientProf2.deposit_balance}`);
    }

    // Verify upline L1 pending commission (10% of ৳5,000 = ৳500)
    const l1ProfRes1 = await fetch(`${BASE_URL}/user/profile`, {
      headers: { 'Authorization': `Bearer ${tokenL1}` }
    });
    const l1Prof1 = await l1ProfRes1.json();
    console.log(`[L1 PROFILE] Pending Comm: ৳${l1Prof1.pending_commission} (Expected: ৳500), Comm Bal: ৳${l1Prof1.commission_balance} (Expected: ৳0)`);
    if (l1Prof1.pending_commission !== 500 || l1Prof1.commission_balance !== 0) {
      throw new Error("Referral commission did not buffer in pending_commission.");
    }
    console.log("[SUCCESS] Referral pending commission buffering verified.");

    // 8. 1-Click Commission Claim
    console.log("\n[TEST] Upline L1 claiming pending commissions via 1-Click claim button...");
    const claimRes = await fetch(`${BASE_URL}/team/claim-commission`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${tokenL1}` }
    });
    const claimData = await claimRes.json();
    console.log(`[RESPONSE] Claim status: ${claimRes.status}, Msg: ${claimData.message}`);

    // Recheck L1 balances
    const l1ProfRes2 = await fetch(`${BASE_URL}/user/profile`, {
      headers: { 'Authorization': `Bearer ${tokenL1}` }
    });
    const l1Prof2 = await l1ProfRes2.json();
    console.log(`[L1 PROFILE] Pending Comm: ৳${l1Prof2.pending_commission} (Expected: ৳0), Comm Bal: ৳${l1Prof2.commission_balance} (Expected: ৳500)`);
    if (l1Prof2.pending_commission !== 0 || l1Prof2.commission_balance !== 500) {
      throw new Error("Commissions were not moved to Commission Balance after 1-Click claim.");
    }
    console.log("[SUCCESS] 1-Click claim movement verified.");

    // 9. Vault dynamic lockup checks (Lock ৳2,000 for 120 days)
    // Credit L1 main balance with ৳2,000 via admin console to lock
    console.log("\n[TEST] Admin adding ৳2,000 to Upline L1 available main balance...");
    await run("UPDATE users SET balance = 2000.0 WHERE id = ?", [l1Prof2.id]);

    console.log("[TEST] Upline L1 locking ৳2,000 in Vault for 120 Days (+50% bonus)...");
    const vaultRes = await fetch(`${BASE_URL}/vault/lock`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${tokenL1}`
      },
      body: JSON.stringify({ amount: 2000, durationDays: 120 })
    });
    const vaultData = await vaultRes.json();
    console.log(`[RESPONSE] Vault lock: ${vaultRes.status}, Msg: ${vaultData.message}`);

    // Recheck L1 profile and locks list
    const locksRes = await fetch(`${BASE_URL}/vault/locks`, {
      headers: { 'Authorization': `Bearer ${tokenL1}` }
    });
    const locks = await locksRes.json();
    console.log(`[L1 VAULT LOCKS] Active locks count: ${locks.length}, Lock #1 duration: ${locks[0].duration_days} days, bonus: +${locks[0].bonus_pct}%`);
    if (locks.length !== 1 || locks[0].duration_days !== 120 || locks[0].bonus_pct !== 50.0) {
      throw new Error("Vault lock data incorrect.");
    }
    console.log("[SUCCESS] Dynamic vault lockup durations verified.");

    console.log("\n=========================================");
    console.log("   ALL TRIPLE-WALLET SYSTEM CHECKS PASS  ");
    console.log("            PASSED SUCCESSFULLY!         ");
    console.log("=========================================");
    process.exit(0);

  } catch (err) {
    console.error("\n❌ [FAIL] Test pipeline error:", err.message);
    process.exit(1);
  }
}

runTests();
