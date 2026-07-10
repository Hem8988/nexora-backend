const BASE_URL = 'http://localhost:5000/api';

async function runTests() {
  console.log("=== STARTING DAILY TASKS INTEGRATION TESTS ===");

  try {
    const randomSuffix = Math.floor(1000 + Math.random() * 9000);
    const phone = `+88017${randomSuffix}`;
    const password = 'TestPassword123';

    // 1. Sign up user
    console.log(`\n[TEST 1] Registering user: ${phone}`);
    const signupRes = await fetch(`${BASE_URL}/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        phone,
        password,
        countryCode: '+880',
        currency: 'USD'
      })
    });
    const signupData = await signupRes.json();
    console.log("Signup Response:", signupData);

    if (signupRes.status !== 201) {
      throw new Error(`Signup failed: ${JSON.stringify(signupData)}`);
    }

    // 2. Login user to get JWT token
    console.log(`\n[TEST 2] Logging in user: ${phone}`);
    const loginRes = await fetch(`${BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, password })
    });
    const loginData = await loginRes.json();
    if (!loginRes.ok) throw new Error(`Login failed: ${loginData.error}`);
    const token = loginData.token;
    console.log("Logged in successfully. Token received.");

    // 3. Fetch User Profile
    console.log("\n[TEST 3] Fetching user profile...");
    const profileRes = await fetch(`${BASE_URL}/user/profile`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const profileData = await profileRes.json();
    console.log("Profile tasks info:");
    console.log(` - all_tasks_count: ${profileData.all_tasks_count}`);
    console.log(` - remaining_tasks_count: ${profileData.remaining_tasks_count}`);
    console.log(` - commission_balance: ${profileData.commission_balance}`);

    if (profileData.all_tasks_count !== 1 || profileData.remaining_tasks_count !== 1) {
      throw new Error(`Invalid tasks counts on signup: expected (1, 1), got (${profileData.all_tasks_count}, ${profileData.remaining_tasks_count})`);
    }

    // 4. Fetch User Tasks
    console.log("\n[TEST 4] Fetching user tasks...");
    const tasksRes = await fetch(`${BASE_URL}/tasks`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const tasksData = await tasksRes.json();
    console.log(`Incomplete tasks count: ${tasksData.incomplete.length}`);
    console.log(`Completed tasks count: ${tasksData.completed.length}`);
    if (tasksData.incomplete.length !== 1) {
      throw new Error(`Expected 1 incomplete task, got ${tasksData.incomplete.length}`);
    }

    const taskToRun = tasksData.incomplete[0];
    console.log(`Task details: ID=${taskToRun.id}, tier=${taskToRun.tier_name}, reward=${taskToRun.reward}`);

    // 5. Run/complete the task
    console.log(`\n[TEST 5] Running task ID: ${taskToRun.id}`);
    const runRes = await fetch(`${BASE_URL}/tasks/run`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ taskId: taskToRun.id })
    });
    const runData = await runRes.json();
    console.log("Run task response:", runData);
    if (!runRes.ok) throw new Error(`Failed to run task: ${runData.error}`);

    // 6. Verify counters updated in profile
    console.log("\n[TEST 6] Verifying user profile post-execution...");
    const profileRes2 = await fetch(`${BASE_URL}/user/profile`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const profileData2 = await profileRes2.json();
    console.log("Updated profile tasks info:");
    console.log(` - all_tasks_count: ${profileData2.all_tasks_count}`);
    console.log(` - remaining_tasks_count: ${profileData2.remaining_tasks_count}`);
    console.log(` - commission_balance: ${profileData2.commission_balance}`);

    if (profileData2.remaining_tasks_count !== 0) {
      throw new Error(`Remaining tasks count should be 0, got ${profileData2.remaining_tasks_count}`);
    }

    // 7. Verify tasks updated
    console.log("\n[TEST 7] Fetching updated user tasks...");
    const tasksRes2 = await fetch(`${BASE_URL}/tasks`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const tasksData2 = await tasksRes2.json();
    console.log(`Incomplete tasks count: ${tasksData2.incomplete.length}`);
    console.log(`Completed tasks count: ${tasksData2.completed.length}`);
    if (tasksData2.incomplete.length !== 0 || tasksData2.completed.length !== 1) {
      throw new Error(`Expected 0 incomplete and 1 completed task`);
    }

    console.log("\n=== ALL DAILY TASKS INTEGRATION TESTS PASSED ===");
  } catch (error) {
    console.error("\n!!! INTEGRATION TEST FAILED !!!");
    console.error(error);
  }
}

runTests();
