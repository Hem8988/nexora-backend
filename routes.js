import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import db from './db.js';

const router = express.Router();
const JWT_SECRET = 'nexora_jwt_secret_key_2026';

export function getTaskLimit(tierName) {
  if (tierName === 'Gold Refinery Reserve' || tierName === 'Gold Refining Facility') return 10;
  if (tierName === 'Green Data Center') return 9;
  if (tierName === 'Biomass Power Plant' || tierName === 'Biomass Energy Plant') return 8;
  if (tierName === 'Industrial Hydro-Plant') return 7;
  if (tierName === 'Wind Farm Asset' || tierName === 'Wind Turbine Project') return 6;
  if (tierName === 'Agro-Solar Pump') return 5;
  if (tierName === 'Solar Community Hub' || tierName === 'Lithium Battery Refinery') return 4;
  if (tierName === 'Smart Home Grid') return 3;
  if (tierName === 'Eco-Mini Grid' || tierName === 'Solar Power Grid') return 2;
  return 1; // Free Starter Pack or None
}

export async function resetDailyTasksForUser(userId) {
  // Clear existing tasks
  await db.run("DELETE FROM completed_tasks WHERE user_id = ?", [userId]);
  await db.run("DELETE FROM incomplete_tasks WHERE user_id = ?", [userId]);

  // Find all active contracts
  const contracts = await db.all("SELECT * FROM contracts WHERE user_id = ? AND status = 'active'", [userId]);

  // Evaluate the user's highest unlocked investment package
  let highestTier = 'Free Starter Pack';
  let highestPrice = -1;
  for (const c of contracts) {
    if (c.price > highestPrice) {
      highestPrice = c.price;
      highestTier = c.tier_name;
    }
  }

  // Calculate task limit
  const taskLimit = getTaskLimit(highestTier);

  // Reload counters
  await db.run("UPDATE users SET all_tasks_count = ?, remaining_tasks_count = ? WHERE id = ?", [taskLimit, taskLimit, userId]);

  // Calculate rewards
  let totalDailyEarning = 0;
  for (const c of contracts) {
    totalDailyEarning += Math.round((c.price * c.daily_roi) * 100) / 100;
  }

  const singleTaskReward = taskLimit > 0 ? (totalDailyEarning / taskLimit) : 0;

  for (let i = 0; i < taskLimit; i++) {
    const assocContract = contracts[i % contracts.length] || { id: 0, tier_name: 'Free Starter Pack' };
    await db.run(
      `INSERT INTO incomplete_tasks (user_id, contract_id, tier_name, reward)
       VALUES (?, ?, ?, ?)`,
      [userId, assocContract.id, assocContract.tier_name, singleTaskReward]
    );
  }
}

// Middleware to verify JWT Token
export function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: "Access denied. Token missing." });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: "Invalid or expired token." });
    }
    req.user = user;
    next();
  });
}

// Middleware to verify Admin Token
export function authenticateAdmin(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: "Access denied. Token missing." });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err || !user.isAdmin) {
      return res.status(403).json({ error: "Admin authorization required." });
    }
    req.user = user;
    next();
  });
}

// -------------------------------------------------------------
// AUTH ENDPOINTS
// -------------------------------------------------------------

// Sign Up
router.post('/auth/signup', async (req, res) => {
  const { phone, password, referredByCode } = req.body;
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';

  if (!phone || !password) {
    return res.status(400).json({ error: "Phone number and password are required." });
  }

  try {
    // 1. IP Check to prevent mass fake accounts (raised limit for testing)
    const ipCheck = await db.get("SELECT COUNT(*) as count FROM users WHERE created_ip = ?", [ip]);
    if (ipCheck.count >= 500) {
      return res.status(400).json({ error: "Anti-fraud block: Maximum accounts per IP exceeded." });
    }

    // 2. Validate Country Code and assign currency
    let countryCode = '';
    const currency = 'USD';

    if (phone.startsWith('+880')) {
      countryCode = '+880';
    } else if (phone.startsWith('+91')) {
      countryCode = '+91';
    } else if (phone.startsWith('+')) {
      const match = phone.match(/^\+(\d{1,4})/);
      countryCode = match ? `+${match[1]}` : '+1';
    } else {
      return res.status(400).json({ error: "Phone number must start with '+' and contain a country code." });
    }

    // 3. Check for existing phone
    const existingUser = await db.get("SELECT id FROM users WHERE phone = ?", [phone]);
    if (existingUser) {
      return res.status(400).json({ error: "Phone number already registered." });
    }

    // 4. Verify Referral Code (Upline)
    let referredById = null;
    if (referredByCode) {
      const uplineUser = await db.get("SELECT id FROM users WHERE referral_code = ?", [referredByCode]);
      if (uplineUser) {
        referredById = uplineUser.id;
      } else {
        return res.status(400).json({ error: "Invalid referral code." });
      }
    }

    // 5. Hash password and generate unique referral code
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);
    
    // Generate referral code based on timestamp and phone suffix
    const suffix = phone.slice(-4);
    const referralCode = `NEX-${suffix}-${Math.floor(100 + Math.random() * 900)}`;

    // 6. Insert User with Triple-Wallet balance attributes and default task limits
    const userResult = await db.run(
      `INSERT INTO users (phone, password_hash, country_code, currency, total_balance, deposit_balance, commission_balance, referral_code, referred_by, created_ip, all_tasks_count, remaining_tasks_count) 
       VALUES (?, ?, ?, ?, 0.0, 0.0, 0.0, ?, ?, ?, 1, 1)`,
      [phone, passwordHash, countryCode, currency, referralCode, referredById, ip]
    );
    const userId = userResult.id;

    // Create free starter contract by default
    const contractResult = await db.run(
      `INSERT INTO contracts (user_id, tier_name, price, daily_roi, duration_days, last_claimed_at) 
       VALUES (?, 'Free Starter Pack', 0.0, 0.0, 180, NULL)`,
      [userId]
    );

    // Create first daily task entry in incomplete_tasks array
    await db.run(
      `INSERT INTO incomplete_tasks (user_id, contract_id, tier_name, reward)
       VALUES (?, ?, 'Free Starter Pack', 0.0)`,
      [userId, contractResult.id]
    );

    res.status(201).json({ message: "Registration successful. Please login." });
  } catch (error) {
    console.error("Signup error:", error);
    res.status(500).json({ error: "Server error during registration." });
  }
});

// User Login
router.post('/auth/login', async (req, res) => {
  const { phone, password } = req.body;

  if (!phone || !password) {
    return res.status(400).json({ error: "Phone and password are required." });
  }

  try {
    const user = await db.get("SELECT * FROM users WHERE phone = ?", [phone]);
    if (!user) {
      return res.status(400).json({ error: "Invalid phone number or password." });
    }

    if (user.status === 'frozen') {
      return res.status(403).json({ error: "Your account is frozen. Contact administrator." });
    }

    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(400).json({ error: "Invalid phone number or password." });
    }

    const token = jwt.sign(
      { id: user.id, phone: user.phone, currency: user.currency, isAdmin: false },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      token,
      user: {
        phone: user.phone,
        currency: user.currency,
        referralCode: user.referral_code
      }
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ error: "Server error during login." });
  }
});

// Admin Login
router.post('/auth/admin-login', async (req, res) => {
  const { username, password } = req.body;

  if (username === 'admin' && password === 'admin123') {
    const token = jwt.sign(
      { username, isAdmin: true },
      JWT_SECRET,
      { expiresIn: '24h' }
    );
    return res.json({ token, isAdmin: true });
  }

  res.status(401).json({ error: "Invalid admin credentials." });
});

// -------------------------------------------------------------
// USER DASHBOARD ENDPOINTS
// -------------------------------------------------------------

// Get user profile summary
router.get('/user/profile', authenticateToken, async (req, res) => {
  try {
    const user = await db.get(
      "SELECT id, phone, currency, total_balance, vault_balance, vault_locked_until, status, referral_code, referred_by, deposit_balance, commission_balance, level1_pending_comm, level2_pending_comm, level3_pending_comm, claimed_milestones, milestone_recruitment_claimed, avatar, email, full_name, all_tasks_count, remaining_tasks_count FROM users WHERE id = ?",
      [req.user.id]
    );

    if (!user) {
      return res.status(404).json({ error: "User not found." });
    }

    if (user.status === 'frozen') {
      return res.status(403).json({ error: "Your account has been frozen." });
    }

    // Get active investments stats
    const contractsCount = await db.get("SELECT COUNT(*) as activeCount, SUM(price) as activeInvested FROM contracts WHERE user_id = ? AND status = 'active'", [user.id]);
    const earningsSum = await db.get("SELECT SUM(total_returned) as totalEarned FROM contracts WHERE user_id = ?", [user.id]);
    
    // Get team stats (Level 1, 2, 3 invite counts)
    const level1 = await db.all("SELECT id FROM users WHERE referred_by = ?", [user.id]);
    const level1Ids = level1.map(u => u.id);

    let level2Count = 0;
    let level3Count = 0;
    let level2Ids = [];

    if (level1Ids.length > 0) {
      const level2 = await db.all(`SELECT id FROM users WHERE referred_by IN (${level1Ids.map(() => '?').join(',')})`, level1Ids);
      level2Ids = level2.map(u => u.id);
      level2Count = level2Ids.length;
    }

    if (level2Ids.length > 0) {
      const level3 = await db.all(`SELECT id FROM users WHERE referred_by IN (${level2Ids.map(() => '?').join(',')})`, level2Ids);
      level3Count = level3.length;
    }

    // Calculate today's referrals who signed up and deposited today
    const todayStart = new Date();
    todayStart.setUTCHours(0,0,0,0);
    const todayReferrals = await db.all(
      "SELECT id FROM users WHERE referred_by = ? AND date(created_at) = date(?)",
      [user.id, todayStart.toISOString()]
    );
    
    let todayReferralsWithDeposit = 0;
    if (todayReferrals.length > 0) {
      const ids = todayReferrals.map(r => r.id);
      const depositsToday = await db.all(
        `SELECT DISTINCT user_id FROM transactions WHERE user_id IN (${ids.map(() => '?').join(',')}) AND type = 'deposit' AND status = 'approved' AND date(created_at) = date(?)`,
        [...ids, todayStart.toISOString()]
      );
      todayReferralsWithDeposit = depositsToday.length;
    }

    // Calculate count of Level 1 downlines with active Tier 1+ projects
    const activeDownlinesCount = await db.get(`
      SELECT COUNT(DISTINCT user_id) as count 
      FROM contracts 
      WHERE user_id IN (SELECT id FROM users WHERE referred_by = ?) AND status = 'active' AND price >= 10
    `, [user.id]);

    res.json({
      id: user.id,
      phone: user.phone,
      currency: 'USD',
      balance: user.total_balance || 0, // legacy UI compatibility
      total_balance: user.total_balance || 0,
      vault_balance: user.vault_balance || 0,
      vault_locked_until: user.vault_locked_until,
      deposit_balance: user.deposit_balance || 0,
      commission_balance: user.commission_balance || 0,
      pending_commission: (user.level1_pending_comm || 0) + (user.level2_pending_comm || 0) + (user.level3_pending_comm || 0),
      level1_pending_comm: user.level1_pending_comm || 0,
      level2_pending_comm: user.level2_pending_comm || 0,
      level3_pending_comm: user.level3_pending_comm || 0,
      claimed_milestones: user.claimed_milestones || '',
      milestone_recruitment_claimed: user.milestone_recruitment_claimed || 0,
      avatar: user.avatar || null,
      email: user.email || '',
      full_name: user.full_name || '',
      all_tasks_count: user.all_tasks_count || 0,
      remaining_tasks_count: user.remaining_tasks_count || 0,
      stats: {
        activeContracts: contractsCount.activeCount || 0,
        totalInvested: contractsCount.activeInvested || 0,
        totalEarned: earningsSum.totalEarned || 0,
        teamCount: level1.length + level2Count + level3Count,
        teamBreakdown: {
          level1: level1.length,
          level2: level2Count,
          level3: level3Count
        },
        todayReferralsWithDeposit,
        activeDownlinesCount: activeDownlinesCount.count || 0
      }
    });
  } catch (error) {
    console.error("Fetch profile error:", error);
    res.status(500).json({ error: "Server error fetching profile." });
  }
});

// -------------------------------------------------------------
// INVESTMENT CONTRACTS & CLAIMS
// -------------------------------------------------------------

// Available Packages Definition (Server-side validation source) - Updated for 5 Tiers with 180 Days lock-in
const INVESTMENT_TIERS = {
  BDT: [
    { id: 'solar', name: "Solar Power Grid", price: 1000, dailyRoi: 0.03, duration: 180 },
    { id: 'wind', name: "Wind Turbine Project", price: 5000, dailyRoi: 0.032, duration: 180 },
    { id: 'biomass', name: "Biomass Energy Plant", price: 15000, dailyRoi: 0.034, duration: 180 },
    { id: 'lithium', name: "Lithium Battery Refinery", price: 45000, dailyRoi: 0.036, duration: 180 },
    { id: 'gold', name: "Gold Refining Facility", price: 100000, dailyRoi: 0.038, duration: 180 }
  ],
  INR: [
    { id: 'solar', name: "Solar Power Grid", price: 800, dailyRoi: 0.03, duration: 180 },
    { id: 'wind', name: "Wind Turbine Project", price: 4000, dailyRoi: 0.032, duration: 180 },
    { id: 'biomass', name: "Biomass Energy Plant", price: 12000, dailyRoi: 0.034, duration: 180 },
    { id: 'lithium', name: "Lithium Battery Refinery", price: 36000, dailyRoi: 0.036, duration: 180 },
    { id: 'gold', name: "Gold Refining Facility", price: 80000, dailyRoi: 0.038, duration: 180 }
  ]
};

// Public: Get All Investment Packages (with display columns)
router.get('/invest/packages', async (req, res) => {
  try {
    // Return only the 10 canonical tiers (exclude legacy test-suite packages)
    const pkgs = await db.all(
      `SELECT * FROM packages WHERE id IN ('free_starter','eco_mini','smart_home','solar_hub','agro_pump','wind_farm','hydro_plant','biomass_plant','data_center','gold_reserve') ORDER BY price ASC`
    );
    res.json(pkgs);
  } catch (error) {
    res.status(500).json({ error: 'Failed to load investment packages.' });
  }
});


// Purchase Asset Unit (Deducts from deposit_balance)
router.post('/invest/activate', authenticateToken, async (req, res) => {
  const { tierId } = req.body;
  const userId = req.user.id;

  try {
    const purchaseResult = await db.runTransaction(async () => {
      // 1. Fetch package details
      const selectedTier = await db.get("SELECT * FROM packages WHERE id = ?", [tierId]);
      if (!selectedTier) {
        throw new Error("Invalid project tier selection.");
      }

      // Check user and balance
      const user = await db.get("SELECT * FROM users WHERE id = ?", [userId]);
      if (!user) throw new Error("User not found");
      if (user.status === 'frozen') throw new Error("Account frozen");

      // Special handling for free tier (price = 0, no deduction needed)
      if (selectedTier.price === 0) {
        // Check if user already has a free_starter contract
        const existingFree = await db.get(
          "SELECT id FROM contracts WHERE user_id = ? AND tier_name = ? AND status = 'active'",
          [userId, selectedTier.name]
        );
        if (existingFree) {
          throw new Error("Free Starter Pack is already active on your account.");
        }
      } else if (user.country_code === '+91') {
        // Legacy India mode: verify and deduct from total_balance/balance
        const effectiveBal = Math.max(user.total_balance || 0, user.balance || 0);
        if (effectiveBal < selectedTier.price) {
          throw new Error(`Insufficient Balance. Need ₹${selectedTier.price}.`);
        }
        await db.run(
          "UPDATE users SET deposit_balance = deposit_balance - ?, total_balance = total_balance - ?, balance = balance - ? WHERE id = ?",
          [selectedTier.price, selectedTier.price, selectedTier.price, userId]
        );
      } else {
        // Premium Mode: verify and deduct from deposit_balance only
        if (user.deposit_balance < selectedTier.price) {
          throw new Error(`Insufficient Deposit Balance. Please recharge.`);
        }
        await db.run("UPDATE users SET deposit_balance = deposit_balance - ? WHERE id = ?", [selectedTier.price, userId]);
      }

      // 3. Create active contract with maturity date
      const dailyRoi = selectedTier.price > 0 ? (selectedTier.daily_return / selectedTier.price) : 0;
      const now = new Date();
      const maturityDate = new Date(now);
      maturityDate.setDate(maturityDate.getDate() + selectedTier.lock_days);

      const contractResult = await db.run(
        `INSERT INTO contracts (user_id, tier_name, price, daily_roi, duration_days, last_claimed_at) 
         VALUES (?, ?, ?, ?, ?, NULL)`,
        [userId, selectedTier.name, selectedTier.price, dailyRoi, selectedTier.lock_days]
      );
      const contractId = contractResult.id;

      // 3-Tier referral commission engine (only for paid tiers)
      if (selectedTier.price > 0) {
        let currentUplineId = user.referred_by;
        const commissionRates = [0.10, 0.04, 0.01]; // Level 1 (10%), Level 2 (4%), Level 3 (1%)

        for (let level = 1; level <= 3; level++) {
          if (!currentUplineId) break;

          const upline = await db.get("SELECT id, country_code, referred_by FROM users WHERE id = ?", [currentUplineId]);
          if (!upline) break;

          let commAmount = selectedTier.price * commissionRates[level - 1];
          commAmount = Math.round(commAmount * 100) / 100;

          if (upline.country_code === '+91') {
            await db.run(
              `UPDATE users SET total_balance = total_balance + ?, balance = balance + ? WHERE id = ?`,
              [commAmount, commAmount, upline.id]
            );
            await db.run(
              `INSERT INTO transactions (user_id, type, amount, currency, status, details) 
               VALUES (?, 'referral_comm', ?, 'USD', 'approved', ?)`,
              [upline.id, commAmount, `Instant Level ${level} Commission from lease purchase of user ID ${userId}`]
            );
          } else {
            const col = `level${level}_pending_comm`;
            await db.run(`UPDATE users SET ${col} = ${col} + ? WHERE id = ?`, [commAmount, upline.id]);
            await db.run(
              `INSERT INTO transactions (user_id, type, amount, currency, status, details) 
               VALUES (?, 'referral_comm_pending', ?, 'USD', 'approved', ?)`,
              [upline.id, commAmount, `Pending Level ${level} Commission from lease purchase of user ID ${userId}`]
            );
          }

          currentUplineId = upline.referred_by;
        }
      }

      // 4. Record contract purchase transaction (skip for free tier)
      if (selectedTier.price > 0) {
        await db.run(
          `INSERT INTO transactions (user_id, type, amount, currency, status, details) 
           VALUES (?, 'activate_contract', ?, 'USD', 'approved', ?)`,
          [userId, selectedTier.price, `Activated ${selectedTier.name} (180-day Lease)`]
        );
      }

      // 5. Task Unlock Hook — update user's task tier access by resetting tier restrictions
      // Determine tier level from package id mapping
      const tierLevelMap = {
        'free_starter': 0, 'eco_mini': 1, 'smart_home': 2, 'solar_hub': 3,
        'agro_pump': 4, 'wind_farm': 5, 'hydro_plant': 6, 'biomass_plant': 7,
        'data_center': 8, 'gold_reserve': 9
      };
      const newTierLevel = tierLevelMap[tierId] !== undefined ? tierLevelMap[tierId] : 0;

      // Record task unlock event in labour_logs for tracking
      await db.run(
        `INSERT INTO labour_logs (phone, tier_name, task_instance, status, timestamp)
         VALUES (?, ?, ?, 'In-Progress / Unchecked', ?)`,
        [user.phone, `Tier ${newTierLevel}: ${selectedTier.name}`, 'Task #1 of 5', new Date().toISOString()]
      );

      return { contractId, price: selectedTier.price, tierName: selectedTier.name, maturityDate: maturityDate.toISOString() };
    });

    await resetDailyTasksForUser(userId);

    res.json({
      message: `${purchaseResult.tierName} contract leased successfully.`,
      contract: purchaseResult
    });
  } catch (error) {
    console.error("Contract activation error:", error.message);
    res.status(400).json({ error: error.message || "Activation failed." });
  }
});


// Get User's Contracts
router.get('/invest/contracts', authenticateToken, async (req, res) => {
  try {
    const contracts = await db.all(
      "SELECT * FROM contracts WHERE user_id = ? ORDER BY id DESC",
      [req.user.id]
    );
    res.json(contracts);
  } catch (error) {
    res.status(500).json({ error: "Failed to load contracts." });
  }
});

// GET /api/tasks (returns incomplete and completed tasks)
router.get('/tasks', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  try {
    const incomplete = await db.all("SELECT * FROM incomplete_tasks WHERE user_id = ? ORDER BY id ASC", [userId]);
    const completed = await db.all("SELECT * FROM completed_tasks WHERE user_id = ? ORDER BY id DESC", [userId]);
    res.json({ incomplete, completed });
  } catch (error) {
    res.status(500).json({ error: "Failed to load tasks: " + error.message });
  }
});

// POST /api/tasks/run (runs task, completes transaction, updates balances)
router.post('/tasks/run', authenticateToken, async (req, res) => {
  const { taskId } = req.body;
  const userId = req.user.id;

  if (!taskId) return res.status(400).json({ error: "Task ID is required." });

  try {
    const result = await db.runTransaction(async () => {
      // 1. Fetch incomplete task
      const task = await db.get("SELECT * FROM incomplete_tasks WHERE id = ? AND user_id = ?", [taskId, userId]);
      if (!task) throw new Error("Task not found or already completed.");

      // 2. Fetch user profile
      const user = await db.get("SELECT * FROM users WHERE id = ?", [userId]);
      if (!user) throw new Error("User not found.");

      // 3. Move task to completed_tasks
      await db.run("DELETE FROM incomplete_tasks WHERE id = ?", [taskId]);
      await db.run(
        `INSERT INTO completed_tasks (id, user_id, contract_id, tier_name, reward, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [task.id, userId, task.contract_id, task.tier_name, task.reward, task.created_at]
      );

      // 4. Update user balance counters
      const nextRemaining = Math.max(0, user.remaining_tasks_count - 1);
      await db.run(
        `UPDATE users 
         SET remaining_tasks_count = ?, 
             commission_balance = commission_balance + ?, 
             total_balance = total_balance + ? 
         WHERE id = ?`,
        [nextRemaining, task.reward, task.reward, userId]
      );

      // 5. Record transaction log
      await db.run(
        `INSERT INTO transactions (user_id, type, amount, currency, status, details)
         VALUES (?, 'task_reward', ?, 'USD', 'approved', ?)`,
        [userId, task.reward, `Completed daily telemetry validation task for ${task.tier_name}`]
      );

      // 6. Record log in labour_logs for live monitoring ledger
      const stepIndex = user.all_tasks_count - nextRemaining;
      await db.run(
        `INSERT INTO labour_logs (phone, tier_name, task_instance, status, timestamp)
         VALUES (?, ?, ?, 'Successfully Processed', ?)`,
        [user.phone, task.tier_name, `Task #${stepIndex} of ${user.all_tasks_count}`, new Date().toISOString()]
      );

      return { reward: task.reward, remaining: nextRemaining };
    });

    res.json({
      message: "Telemetry synchronization validated successfully! Payout credited to your commission wallet.",
      reward: result.reward,
      remaining: result.remaining
    });
  } catch (error) {
    console.error("Task run error:", error.message);
    res.status(400).json({ error: error.message });
  }
});

// Gamified Claim Engine: Collect Energy Units (Daily Claim)
router.post('/invest/claim', authenticateToken, async (req, res) => {
  const { contractId } = req.body;
  const userId = req.user.id;

  try {
    const claimResult = await db.runTransaction(async () => {
      // 1. Fetch contract
      const contract = await db.get("SELECT * FROM contracts WHERE id = ? AND user_id = ?", [contractId, userId]);
      if (!contract) throw new Error("Contract not found.");
      if (contract.status !== 'active') throw new Error("Contract is no longer active.");

      const now = new Date();
      
      // 2. Validate double claims (once per calendar day)
      if (contract.last_claimed_at) {
        const lastClaimDate = new Date(contract.last_claimed_at);
        
        // Match simple date boundaries (UTC / local day)
        const isSameDay = lastClaimDate.getUTCDate() === now.getUTCDate() &&
                          lastClaimDate.getUTCMonth() === now.getUTCMonth() &&
                          lastClaimDate.getUTCFullYear() === now.getUTCFullYear();
        
        if (isSameDay) {
          throw new Error("Energy units already collected for today. Come back tomorrow!");
        }
      }

      // 3. Compute earnings
      const dailyEarning = Math.round((contract.price * contract.daily_roi) * 100) / 100;
      const nextElapsed = contract.days_elapsed + 1;
      const newTotalReturned = contract.total_returned + dailyEarning;
      const nextStatus = nextElapsed >= contract.duration_days ? 'completed' : 'active';

      // 4. Update user total_balance and balance
      await db.run("UPDATE users SET total_balance = total_balance + ?, balance = balance + ? WHERE id = ?", [dailyEarning, dailyEarning, userId]);

      // 5. Update contract status
      await db.run(
        `UPDATE contracts 
         SET days_elapsed = ?, last_claimed_at = ?, total_returned = ?, status = ? 
         WHERE id = ?`,
        [nextElapsed, now.toISOString(), newTotalReturned, nextStatus, contractId]
      );

      // 6. Record transaction log
      await db.run(
        `INSERT INTO transactions (user_id, type, amount, currency, status, details) 
         VALUES (?, 'claim', ?, 'USD', 'approved', ?)`,
        [userId, dailyEarning, `Claimed daily profit for ${contract.tier_name} (${nextElapsed}/${contract.duration_days})`]
      );

      return { dailyEarning, days_elapsed: nextElapsed, status: nextStatus };
    });

    res.json({
      message: `Energy unit harvested successfully! Credited $${claimResult.dailyEarning} to wallet.`,
      result: claimResult
    });
  } catch (error) {
    console.error("Claim error:", error.message);
    res.status(400).json({ error: error.message });
  }
});

// -------------------------------------------------------------
// NEXORA COMPOUND VAULT
// -------------------------------------------------------------

// Lock up daily earnings or commission balances in the compound vault for 60, 120, or 180 days
router.post('/vault/lock', authenticateToken, async (req, res) => {
  const { amount, durationDays } = req.body;
  const userId = req.user.id;

  const numAmount = parseFloat(amount);
  if (isNaN(numAmount) || numAmount <= 0) {
    return res.status(400).json({ error: "Invalid lock amount." });
  }

  const duration = parseInt(durationDays || 120);
  if (![60, 120, 180].includes(duration)) {
    return res.status(400).json({ error: "Invalid lock duration. Choose 60, 120, or 180 days." });
  }

  // Assign fixed bonuses: 60 days (+20%), 120 days (+50%), 180 days (+90%)
  let bonusPct = 0.0;
  if (duration === 60) bonusPct = 20.0;
  else if (duration === 120) bonusPct = 50.0;
  else if (duration === 180) bonusPct = 90.0;

  try {
    const lockResult = await db.runTransaction(async () => {
      const user = await db.get("SELECT * FROM users WHERE id = ?", [userId]);
      if (!user) throw new Error("User not found.");
      if (user.status === 'frozen') throw new Error("Account frozen.");

      // Check available combined balance (total_balance or balance + commission_balance)
      const effectiveEarningsBal = Math.max(user.total_balance || 0, user.balance || 0);
      let remainingToDeduct = numAmount;
      let deductFromEarnings = 0;
      let deductFromComm = 0;

      if (effectiveEarningsBal >= remainingToDeduct) {
        deductFromEarnings = remainingToDeduct;
        remainingToDeduct = 0;
      } else {
        deductFromEarnings = effectiveEarningsBal;
        remainingToDeduct -= effectiveEarningsBal;

        if (user.commission_balance >= remainingToDeduct) {
          deductFromComm = remainingToDeduct;
          remainingToDeduct = 0;
        } else {
          throw new Error("Insufficient combined earnings & commission wallet balance to fund this vault lockup.");
        }
      }

      const now = new Date();
      const unlockDate = new Date();
      unlockDate.setDate(now.getDate() + duration);

      // Deduct from balances (both total_balance and balance columns for compatibility)
      await db.run(
        "UPDATE users SET total_balance = total_balance - ?, balance = balance - ?, commission_balance = commission_balance - ? WHERE id = ?",
        [deductFromEarnings, deductFromEarnings, deductFromComm, userId]
      );

      // Insert lock row
      const insertResult = await db.run(
        `INSERT INTO vault_locks (user_id, amount, duration_days, bonus_pct, unlock_date, status) 
         VALUES (?, ?, ?, ?, ?, 'locked')`,
        [userId, numAmount, duration, bonusPct, unlockDate.toISOString()]
      );

      // Record lock transaction log
      await db.run(
        `INSERT INTO transactions (user_id, type, amount, currency, status, details) 
         VALUES (?, 'vault_lock', ?, 'USD', 'approved', ?)`,
        [userId, numAmount, `Locked in Vault for ${duration} days (Bonus +${bonusPct}%). Unlocks on ${unlockDate.toLocaleDateString()}`]
      );

      return { lockId: insertResult.id, newBalance: user.total_balance - deductFromEarnings, newCommBalance: user.commission_balance - deductFromComm, unlockDate };
    });

    res.json({
      message: `Successfully locked $${numAmount} into Nexora Vault for ${duration} days.`,
      data: lockResult
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Fetch active dynamic locks for the user
router.get('/vault/locks', authenticateToken, async (req, res) => {
  try {
    const locks = await db.all(
      "SELECT * FROM vault_locks WHERE user_id = ? ORDER BY id DESC",
      [req.user.id]
    );
    res.json(locks);
  } catch (error) {
    res.status(500).json({ error: "Failed to load vault locks list." });
  }
});

// Unlock dynamic vault locks and claim principal + fixed bonuses
router.post('/vault/unlock', authenticateToken, async (req, res) => {
  const { lockId } = req.body || {};
  const userId = req.user.id;

  try {
    const unlockResult = await db.runTransaction(async () => {
      let targetLockId = lockId;
      
      if (!targetLockId) {
        // Fallback for legacy compatibility (auto-resolve user's latest locked vault stash)
        const latestLock = await db.get("SELECT id FROM vault_locks WHERE user_id = ? AND status = 'locked' ORDER BY id DESC LIMIT 1", [userId]);
        if (!latestLock) {
          throw new Error("Vault is unlocked. No active locked stashes found.");
        }
        targetLockId = latestLock.id;
      }

      const lock = await db.get("SELECT * FROM vault_locks WHERE id = ? AND user_id = ?", [targetLockId, userId]);
      if (!lock) throw new Error("Vault lock item not found.");
      if (lock.status !== 'locked') throw new Error("This vault lock item is already unlocked.");

      const user = await db.get("SELECT * FROM users WHERE id = ?", [userId]);
      if (!user) throw new Error("User not found.");
      if (user.status === 'frozen') throw new Error("Account frozen.");

      const now = new Date();
      const lockReleaseDate = new Date(lock.unlock_date);

      if (now < lockReleaseDate) {
        const daysLeft = Math.ceil((lockReleaseDate - now) / (1000 * 60 * 60 * 24));
        throw new Error(`Vault is locked. Releases in ${daysLeft} day(s).`);
      }

      // Calculate compound bonus payout
      const bonusAmount = Math.round((lock.amount * (lock.bonus_pct / 100)) * 100) / 100;
      const totalRefund = lock.amount + bonusAmount;

      // Credit back to user's total_balance and balance
      await db.run("UPDATE users SET total_balance = total_balance + ?, balance = balance + ? WHERE id = ?", [totalRefund, totalRefund, userId]);

      // Mark status as unlocked
      await db.run("UPDATE vault_locks SET status = 'unlocked' WHERE id = ?", [targetLockId]);

      // Record unlock transaction log
      await db.run(
        `INSERT INTO transactions (user_id, type, amount, currency, status, details) 
         VALUES (?, 'vault_unlock', ?, 'USD', 'approved', ?)`,
        [userId, totalRefund, `Unlocked Vault Lock #${targetLockId}. Principal + ${lock.bonus_pct}% bonus. Total credited: ${totalRefund}`]
      );

      return { totalRefund, bonusPct: lock.bonus_pct, bonusAmount };
    });

    res.json({
      message: `Vault item unlocked! Credited $${unlockResult.totalRefund} (including +${unlockResult.bonusPct}% bonus) to wallet.`,
      data: unlockResult
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Claim level pending commission into commission_balance
router.post('/team/claim-level-commission', authenticateToken, async (req, res) => {
  const { level } = req.body;
  const userId = req.user.id;

  if (![1, 2, 3].includes(parseInt(level))) {
    return res.status(400).json({ error: "Invalid level specified." });
  }

  try {
    const claimResult = await db.runTransaction(async () => {
      const user = await db.get("SELECT * FROM users WHERE id = ?", [userId]);
      if (!user) throw new Error("User not found.");

      const col = `level${level}_pending_comm`;
      const amount = user[col] || 0;

      if (amount <= 0) {
        throw new Error(`No pending commission rewards to claim for Level ${level}.`);
      }

      // Transfer pending commission to commission_balance
      await db.run(
        `UPDATE users SET commission_balance = commission_balance + ?, ${col} = 0.0 WHERE id = ?`,
        [amount, userId]
      );

      // Record commission claim transaction log
      await db.run(
        `INSERT INTO transactions (user_id, type, amount, currency, status, details) 
         VALUES (?, 'claim_commission', ?, 'USD', 'approved', ?)`,
        [userId, amount, `Claimed Level ${level} Team Commission.`]
      );

      return amount;
    });

    res.json({
      message: `Successfully claimed $${claimResult} Level ${level} commission!`,
      amount: claimResult
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Legacy Claim all pending commissions (for backward compatibility / tests)
router.post('/team/claim-commission', authenticateToken, async (req, res) => {
  const userId = req.user.id;

  try {
    const claimResult = await db.runTransaction(async () => {
      const user = await db.get("SELECT * FROM users WHERE id = ?", [userId]);
      if (!user) throw new Error("User not found.");

      const amount = (user.level1_pending_comm || 0) + (user.level2_pending_comm || 0) + (user.level3_pending_comm || 0);

      if (amount <= 0) {
        throw new Error("No pending commission rewards to claim.");
      }

      // Transfer pending commission to commission_balance and clear all level pending commissions
      await db.run(
        `UPDATE users SET commission_balance = commission_balance + ?, level1_pending_comm = 0.0, level2_pending_comm = 0.0, level3_pending_comm = 0.0 WHERE id = ?`,
        [amount, userId]
      );

      // Record commission claim transaction log
      await db.run(
        `INSERT INTO transactions (user_id, type, amount, currency, status, details) 
         VALUES (?, 'claim_commission', ?, 'USD', 'approved', 'Claimed All Team Commissions.')`,
        [userId, amount]
      );

      return amount;
    });

    res.json({
      message: `Successfully claimed $${claimResult} total team commissions!`,
      amount: claimResult
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Update Account Profile Settings (Avatar, Custom name, Phone, Email, Password verification)
router.post('/user/update-profile', authenticateToken, async (req, res) => {
  const { fullName, phone, email, avatar, oldPassword, newPassword } = req.body;
  const userId = req.user.id;

  try {
    const user = await db.get("SELECT * FROM users WHERE id = ?", [userId]);
    if (!user) return res.status(404).json({ error: "User not found." });

    const updates = [];
    const params = [];

    if (fullName !== undefined) {
      updates.push("full_name = ?");
      params.push(fullName);
    }
    if (phone !== undefined) {
      if (phone !== user.phone) {
        const existing = await db.get("SELECT id FROM users WHERE phone = ?", [phone]);
        if (existing) {
          return res.status(400).json({ error: "Phone number already in use." });
        }
      }
      updates.push("phone = ?");
      params.push(phone);
    }
    if (email !== undefined) {
      updates.push("email = ?");
      params.push(email);
    }
    if (avatar !== undefined) {
      updates.push("avatar = ?");
      params.push(avatar);
    }

    if (newPassword) {
      if (!oldPassword) {
        return res.status(400).json({ error: "Current password is required to change password." });
      }
      const isMatch = await bcrypt.compare(oldPassword, user.password_hash);
      if (!isMatch) {
        return res.status(400).json({ error: "Incorrect current password." });
      }
      const salt = await bcrypt.genSalt(10);
      const passwordHash = await bcrypt.hash(newPassword, salt);
      updates.push("password_hash = ?");
      params.push(passwordHash);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: "No profile update parameters provided." });
    }

    params.push(userId);
    await db.run(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, params);

    res.json({ message: "Profile updated successfully." });
  } catch (error) {
    console.error("Update profile error:", error);
    res.status(500).json({ error: "Server error updating profile." });
  }
});

// -------------------------------------------------------------
// DEPOSIT AND WITHDRAWAL CHANNELS
// -------------------------------------------------------------

// Submit deposit (TrxID manual confirmation receipt)
router.post('/transact/deposit', authenticateToken, async (req, res) => {
  const { amount, channel, trxId } = req.body;
  const userId = req.user.id;

  const numAmount = parseFloat(amount);
  if (isNaN(numAmount) || numAmount <= 0) {
    return res.status(400).json({ error: "Invalid deposit amount." });
  }

  if (!channel || !trxId) {
    return res.status(400).json({ error: "Payment channel and Transaction ID (TrxID) are required." });
  }

  try {
    // Anti-fraud check: Check for unique TrxID string
    const existingTx = await db.get("SELECT id FROM transactions WHERE trx_id = ?", [trxId]);
    if (existingTx) {
      return res.status(400).json({ error: "Anti-fraud block: This Transaction ID has already been submitted." });
    }

    // Insert pending deposit request
    await db.run(
      `INSERT INTO transactions (user_id, type, amount, currency, trx_id, channel, status, details) 
       VALUES (?, 'deposit', ?, 'USD', ?, ?, 'pending', ?)`,
      [userId, numAmount, trxId, channel, `Manual Deposit via ${channel} (TrxID: ${trxId})`]
    );

    res.json({ message: "Deposit receipt submitted successfully. Awaiting manual admin approval." });
  } catch (error) {
    res.status(500).json({ error: "Failed to submit deposit." });
  }
});

// Request withdrawal
router.post('/transact/withdraw', authenticateToken, async (req, res) => {
  const { amount, channel, destination, source } = req.body;
  const userId = req.user.id;

  const numAmount = parseFloat(amount);
  if (isNaN(numAmount) || numAmount <= 0) {
    return res.status(400).json({ error: "Invalid withdrawal amount." });
  }

  if (!channel || !destination) {
    return res.status(400).json({ error: "Withdrawal channel and account details are required." });
  }

  try {
    const withdrawResult = await db.runTransaction(async () => {
      // 1. Fetch user and configurations
      const user = await db.get("SELECT * FROM users WHERE id = ?", [userId]);
      if (!user) throw new Error("User not found.");
      if (user.status === 'frozen') throw new Error("Anti-fraud block: Your account is frozen.");

      // Check VIP status: possess at least one running Tier 1 ($10) or higher active investment project
      const activeContracts = await db.get(
        "SELECT COUNT(*) as count FROM contracts WHERE user_id = ? AND status = 'active' AND price >= 10",
        [userId]
      );
      if ((activeContracts.count || 0) === 0) {
        throw new Error("Task Wallet balance is currently frozen. To permanently activate withdrawals, your account must possess at least one running Tier 1 ($10) or higher active investment project.");
      }

      // Check Global Freeze switch
      const globalFreeze = await db.get("SELECT value FROM settings WHERE key = 'global_freeze'");
      if (globalFreeze && globalFreeze.value === '1') {
        throw new Error("System Alert: Cashouts are temporarily locked for system maintenance. Please try again later.");
      }

      // Check Min cashout limits
      const minLimitRow = await db.get("SELECT value FROM settings WHERE key = 'min_withdrawal_usd'");
      const minLimit = parseFloat(minLimitRow ? minLimitRow.value : '5');

      if (numAmount < minLimit) {
        throw new Error(`Minimum withdrawal amount is $${minLimit}.`);
      }

      // Check user balance based on withdrawal source
      const walletSource = source === 'commission' ? 'commission_balance' : 'total_balance';
      const balanceName = source === 'commission' ? 'commission balance' : 'total balance';

      if (user[walletSource] < numAmount) {
        throw new Error(`Insufficient ${balanceName} to request withdrawal.`);
      }

      // Retrieve withdrawal fee settings
      const feeRow = await db.get("SELECT value FROM settings WHERE key = 'withdrawal_fee_pct'");
      const feePct = parseFloat(feeRow ? feeRow.value : '10');
      const feeAmount = Math.round((numAmount * (feePct / 100)) * 100) / 100;
      const netAmount = numAmount - feeAmount;

      // Deduct balance instantly from selected source (updating both balance columns for total_balance source)
      if (walletSource === 'total_balance') {
        await db.run(`UPDATE users SET total_balance = total_balance - ?, balance = balance - ? WHERE id = ?`, [numAmount, numAmount, userId]);
      } else {
        await db.run(`UPDATE users SET commission_balance = commission_balance - ? WHERE id = ?`, [numAmount, userId]);
      }

      const detailsStr = source === 'commission'
        ? `Withdrawal to ${destination} from Commission Balance. Gross: $${numAmount}, Fee (${feePct}%): $${feeAmount}, Net payout: $${netAmount}`
        : `Withdrawal to ${destination} from Daily Earnings. Gross: $${numAmount}, Fee (${feePct}%): $${feeAmount}, Net payout: $${netAmount}`;

      // Record withdrawal request as pending
      await db.run(
        `INSERT INTO transactions (user_id, type, amount, currency, channel, status, details) 
         VALUES (?, 'withdrawal', ?, 'USD', ?, 'pending', ?)`,
        [userId, numAmount, channel, detailsStr]
      );

      return { newBalance: user[walletSource] - numAmount, feeAmount, netAmount };
    });

    res.json({
      message: "Withdrawal request submitted successfully. Processing payout.",
      data: withdrawResult
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Get User's transaction logs
router.get('/transact/history', authenticateToken, async (req, res) => {
  try {
    const history = await db.all(
      "SELECT * FROM transactions WHERE user_id = ? ORDER BY id DESC LIMIT 50",
      [req.user.id]
    );
    res.json(history);
  } catch (error) {
    res.status(500).json({ error: "Failed to load transaction history." });
  }
});

// -------------------------------------------------------------
// TELEGRAM ALERT SIMULATOR TICKER
// -------------------------------------------------------------
router.get('/telegram/feed', async (req, res) => {
  try {
    const logs = await db.all(`
      SELECT t.id, t.type, t.amount, t.currency, t.created_at, u.phone 
      FROM transactions t
      JOIN users u ON t.user_id = u.id
      WHERE t.type IN ('activate_contract', 'withdrawal', 'referral_comm')
      ORDER BY t.id DESC LIMIT 15
    `);

    const feed = logs.map(item => {
      const parts = item.phone.split('');
      let masked = item.phone;
      if (parts.length > 8) {
        masked = parts.slice(0, 6).join('') + '****' + parts.slice(-2).join('');
      }

      let text = '';
      if (item.type === 'activate_contract') {
        text = `🎉 User ${masked} activated a new project Asset Unit contract worth $${item.amount}!`;
      } else if (item.type === 'withdrawal') {
        text = `💸 User ${masked} successfully processed a payout of $${item.amount} via mobile wallet channels.`;
      } else if (item.type === 'referral_comm') {
        text = `🤝 User ${masked} earned referral invite commissions of $${item.amount}!`;
      }

      return {
        id: item.id,
        text,
        timestamp: item.created_at
      };
    });

    res.json(feed);
  } catch (error) {
    res.status(500).json({ error: "Failed to retrieve social logs." });
  }
});

// -------------------------------------------------------------
// ADMIN MANAGEMENT ENDPOINTS
// -------------------------------------------------------------

// Fetch admin status parameters & totals
router.get('/admin/dashboard', authenticateAdmin, async (req, res) => {
  try {
    const usersCount = await db.get("SELECT COUNT(*) as count FROM users");
    const activeContracts = await db.get("SELECT COUNT(*) as count, SUM(price) as totalInvested FROM contracts WHERE status='active'");
    const totalDeposits = await db.get("SELECT SUM(amount) as total FROM transactions WHERE type='deposit' AND status='approved'");
    const totalWithdrawals = await db.get("SELECT SUM(amount) as total FROM transactions WHERE type='withdrawal' AND status='approved'");

    const users = await db.all("SELECT id, phone, currency, total_balance, deposit_balance, commission_balance, status, created_ip, created_at FROM users ORDER BY id DESC");
    const pendingTransactions = await db.all(`
      SELECT t.id, t.user_id, t.type, t.amount, t.currency, t.trx_id, t.channel, t.status, t.details, t.created_at, u.phone 
      FROM transactions t
      JOIN users u ON t.user_id = u.id
      WHERE t.status = 'pending' AND t.type IN ('deposit', 'withdrawal')
      ORDER BY t.id ASC
    `);

    const systemSettings = await db.all("SELECT * FROM settings");

    res.json({
      summary: {
        totalUsers: usersCount.count || 0,
        activeContractsCount: activeContracts.count || 0,
        activeVolume: activeContracts.totalInvested || 0,
        depositsVolume: totalDeposits.total || 0,
        withdrawalsVolume: totalWithdrawals.total || 0
      },
      users,
      pendingTransactions,
      settings: systemSettings.reduce((acc, current) => {
        acc[current.key] = current.value;
        return acc;
      }, {})
    });
  } catch (error) {
    res.status(500).json({ error: "Server dashboard fetch failed." });
  }
});

// Manual Edit User Balance
router.post('/admin/user/edit-balance', authenticateAdmin, async (req, res) => {
  const { userId, newBalance } = req.body;
  const balanceVal = parseFloat(newBalance);

  if (isNaN(balanceVal)) {
    return res.status(400).json({ error: "Invalid balance value." });
  }

  try {
    await db.run("UPDATE users SET total_balance = ?, balance = ? WHERE id = ?", [balanceVal, balanceVal, userId]);
    // Log as admin adjustment
    await db.run(
      `INSERT INTO transactions (user_id, type, amount, currency, status, details) 
       VALUES (?, 'admin_adjust', ?, 'USD', 'approved', ?)`,
      [userId, balanceVal, `Admin manually edited balance to: $${balanceVal}`]
    );

    res.json({ message: "User balance updated successfully." });
  } catch (error) {
    res.status(500).json({ error: "Failed to edit user balance." });
  }
});

// Toggle User Account Freeze/Unfreeze
router.post('/admin/user/toggle-status', authenticateAdmin, async (req, res) => {
  const { userId, status } = req.body; // 'active' or 'frozen'

  if (status !== 'active' && status !== 'frozen') {
    return res.status(400).json({ error: "Invalid status code." });
  }

  try {
    await db.run("UPDATE users SET status = ? WHERE id = ?", [status, userId]);
    res.json({ message: `User status changed to ${status}.` });
  } catch (error) {
    res.status(500).json({ error: "Failed to adjust user status." });
  }
});

// Approve Pending Transaction (Locks DB immediately to prevent double approvals)
router.post('/admin/transactions/approve', authenticateAdmin, async (req, res) => {
  const { transactionId } = req.body;

  try {
    await db.runTransaction(async () => {
      const tx = await db.get("SELECT * FROM transactions WHERE id = ?", [transactionId]);
      if (!tx) throw new Error("Transaction record not found.");
      if (tx.status !== 'pending') throw new Error("Transaction is already processed.");

      // For deposit: credit user's deposit_balance (and available balance if legacy mode)
      if (tx.type === 'deposit') {
        const user = await db.get("SELECT country_code FROM users WHERE id = ?", [tx.user_id]);
        if (user && user.country_code === '+91') {
          await db.run(
            "UPDATE users SET deposit_balance = deposit_balance + ?, total_balance = total_balance + ?, balance = balance + ? WHERE id = ?",
            [tx.amount, tx.amount, tx.amount, tx.user_id]
          );
        } else {
          await db.run("UPDATE users SET deposit_balance = deposit_balance + ? WHERE id = ?", [tx.amount, tx.user_id]);
        }
      }

      // Update transaction status
      await db.run("UPDATE transactions SET status = 'approved' WHERE id = ?", [transactionId]);
    });

    res.json({ message: "Transaction successfully approved." });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Reject Pending Transaction (Refunds balance for withdrawals to the correct source wallet)
router.post('/admin/transactions/reject', authenticateAdmin, async (req, res) => {
  const { transactionId } = req.body;

  try {
    await db.runTransaction(async () => {
      const tx = await db.get("SELECT * FROM transactions WHERE id = ?", [transactionId]);
      if (!tx) throw new Error("Transaction record not found.");
      if (tx.status !== 'pending') throw new Error("Transaction is already processed.");

      // For withdrawal: Refund the user's deducted balance to its source wallet
      if (tx.type === 'withdrawal') {
        const isComm = tx.details && tx.details.includes("Commission Balance");
        const refundColumn = isComm ? 'commission_balance' : 'total_balance';
        await db.run(`UPDATE users SET ${refundColumn} = ${refundColumn} + ? WHERE id = ?`, [tx.amount, tx.user_id]);
      }

      // Update status
      await db.run("UPDATE transactions SET status = 'rejected' WHERE id = ?", [transactionId]);
    });

    res.json({ message: "Transaction successfully rejected and refunded where applicable." });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Adjust global configuration settings
router.post('/admin/settings', authenticateAdmin, async (req, res) => {
  const { withdrawal_fee_pct, min_withdrawal_usd, global_freeze } = req.body;

  try {
    const update = async (key, val) => {
      if (val !== undefined && val !== null) {
        await db.run("UPDATE settings SET value = ? WHERE key = ?", [String(val), key]);
      }
    };

    await update('withdrawal_fee_pct', withdrawal_fee_pct);
    await update('min_withdrawal_usd', min_withdrawal_usd);
    await update('global_freeze', global_freeze);

    res.json({ message: "Global configurations modified successfully." });
  } catch (error) {
    res.status(500).json({ error: "Failed to update configurations." });
  }
});

// -------------------------------------------------------------
// USER TASKS & ATTENDANCE ENDPOINTS
// -------------------------------------------------------------

// Claim Daily Attendance ($0.20 credited instantly)
router.post('/tasks/attendance', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const now = new Date();
  
  try {
    // Check if already claimed today
    const lastClaim = await db.get(
      "SELECT created_at FROM task_submissions WHERE user_id = ? AND task_name = 'Daily Attendance' ORDER BY id DESC LIMIT 1",
      [userId]
    );

    if (lastClaim) {
      const lastDate = new Date(lastClaim.created_at);
      const isSameDay = lastDate.getUTCDate() === now.getUTCDate() &&
                        lastDate.getUTCMonth() === now.getUTCMonth() &&
                        lastDate.getUTCFullYear() === now.getUTCFullYear();
      if (isSameDay) {
        return res.status(400).json({ error: "Daily attendance already claimed for today." });
      }
    }

    const reward = 0.20;
    await db.runTransaction(async () => {
      // Insert into task_submissions
      await db.run(
        "INSERT INTO task_submissions (user_id, task_name, status, reward) VALUES (?, 'Daily Attendance', 'approved', ?)",
        [userId, reward]
      );
      // Credit to commission_balance
      await db.run("UPDATE users SET commission_balance = commission_balance + ? WHERE id = ?", [reward, userId]);
      // Record transaction
      await db.run(
        "INSERT INTO transactions (user_id, type, amount, currency, status, details) VALUES (?, 'task_reward', ?, 'USD', 'approved', 'Daily Attendance Reward')",
        [userId, reward]
      );
    });

    res.json({ message: "Daily attendance verified. $0.20 credited to Commission Balance." });
  } catch (err) {
    res.status(500).json({ error: "Attendance failed: " + err.message });
  }
});

// Submit Social Sharing Proof ($1.00 uploader)
router.post('/tasks/submit', authenticateToken, async (req, res) => {
  const { taskName, proofImage } = req.body;
  const userId = req.user.id;

  if (!taskName || !proofImage) {
    return res.status(400).json({ error: "Task name and screenshot proof are required." });
  }

  try {
    const reward = 1.00;
    await db.run(
      "INSERT INTO task_submissions (user_id, task_name, proof_image, status, reward) VALUES (?, ?, ?, 'pending', ?)",
      [userId, taskName, proofImage, reward]
    );
    res.json({ message: "Social proof uploaded successfully. Awaiting manual admin review." });
  } catch (err) {
    res.status(500).json({ error: "Submission failed: " + err.message });
  }
});

// Claim Team Leader Level Milestone
router.post('/user/claim-leader-milestone', authenticateToken, async (req, res) => {
  const { milestoneId } = req.body;
  const userId = req.user.id;

  const milestones = {
    1: { target: 2, reward: 2.00 },
    2: { target: 5, reward: 7.00 },
    3: { target: 10, reward: 20.00 }
  };

  const milestone = milestones[milestoneId];
  if (!milestone) return res.status(400).json({ error: "Invalid milestone selection." });

  try {
    await db.runTransaction(async () => {
      const user = await db.get("SELECT claimed_milestones FROM users WHERE id = ?", [userId]);
      if (!user) throw new Error("User not found.");

      const claimed = user.claimed_milestones ? user.claimed_milestones.split(',') : [];
      if (claimed.includes(String(milestoneId))) {
        throw new Error("This milestone has already been claimed.");
      }

      // Check current progress
      const todayStart = new Date();
      todayStart.setUTCHours(0,0,0,0);
      
      const todayReferrals = await db.all(
        "SELECT id FROM users WHERE referred_by = ? AND date(created_at) = date(?)",
        [userId, todayStart.toISOString()]
      );
      
      let referralsWithDepositCount = 0;
      if (todayReferrals.length > 0) {
        const ids = todayReferrals.map(r => r.id);
        const depositsToday = await db.all(
          `SELECT DISTINCT user_id FROM transactions WHERE user_id IN (${ids.map(() => '?').join(',')}) AND type = 'deposit' AND status = 'approved' AND date(created_at) = date(?)`,
          [...ids, todayStart.toISOString()]
        );
        referralsWithDepositCount = depositsToday.length;
      }

      if (referralsWithDepositCount < milestone.target) {
        throw new Error(`Milestone progress insufficient. Need ${milestone.target} referrals with deposits today.`);
      }

      // Update claimed milestones
      claimed.push(String(milestoneId));
      const newClaimed = claimed.join(',');

      // Add reward to total_balance and balance
      await db.run("UPDATE users SET total_balance = total_balance + ?, balance = balance + ?, claimed_milestones = ? WHERE id = ?", [
        milestone.reward, milestone.reward, newClaimed, userId
      ]);

      // Log transaction
      await db.run(
        "INSERT INTO transactions (user_id, type, amount, currency, status, details) VALUES (?, 'milestone_reward', ?, 'USD', 'approved', ?)",
        [userId, milestone.reward, `Claimed Team Leader Level ${milestoneId} Milestone Reward.`]
      );
    });

    res.json({ message: `Milestone ${milestoneId} reward successfully claimed!` });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Claim Tasks Tab 3 Active Downlines Milestone
router.post('/user/claim-recruitment-milestone', authenticateToken, async (req, res) => {
  const userId = req.user.id;

  try {
    await db.runTransaction(async () => {
      const user = await db.get("SELECT milestone_recruitment_claimed FROM users WHERE id = ?", [userId]);
      if (!user) throw new Error("User not found.");

      if (user.milestone_recruitment_claimed === 1) {
        throw new Error("Recruitment milestone reward has already been claimed.");
      }

      const activeDownlines = await db.get(`
        SELECT COUNT(DISTINCT user_id) as count 
        FROM contracts 
        WHERE user_id IN (SELECT id FROM users WHERE referred_by = ?) AND status = 'active' AND price >= 10
      `, [userId]);

      if ((activeDownlines.count || 0) < 3) {
        throw new Error("Progress insufficient. You need at least 3 direct downlines with active Tier 1+ projects.");
      }

      // Credit reward to total_balance and balance
      await db.run(
        "UPDATE users SET total_balance = total_balance + 10.0, balance = balance + 10.0, milestone_recruitment_claimed = 1 WHERE id = ?",
        [userId]
      );

      // Log transaction
      await db.run(
        "INSERT INTO transactions (user_id, type, amount, currency, status, details) VALUES (?, 'milestone_reward', 10.0, 'USD', 'approved', 'Claimed Recruitment Milestone Reward (3 Active Downlines)')",
        [userId]
      );
    });

    res.json({ message: "Recruitment milestone claimed! $10.00 credited to Total Balance." });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// -------------------------------------------------------------
// ADMIN TASK VERIFICATION MODULE
// -------------------------------------------------------------

// Fetch pending task submissions
router.get('/admin/task-submissions', authenticateAdmin, async (req, res) => {
  try {
    const submissions = await db.all(`
      SELECT t.id, t.user_id, t.task_name, t.proof_image, t.status, t.reward, t.created_at, u.phone 
      FROM task_submissions t
      JOIN users u ON t.user_id = u.id
      WHERE t.status = 'pending'
      ORDER BY t.id ASC
    `);
    res.json(submissions);
  } catch (err) {
    res.status(500).json({ error: "Failed to load task submissions." });
  }
});

// Verify task submission (Approve / Reject)
router.post('/admin/task-submissions/verify', authenticateAdmin, async (req, res) => {
  const { submissionId, action } = req.body; // action: 'approve' or 'reject'

  if (!['approve', 'reject'].includes(action)) {
    return res.status(400).json({ error: "Invalid action." });
  }

  try {
    await db.runTransaction(async () => {
      const sub = await db.get("SELECT * FROM task_submissions WHERE id = ?", [submissionId]);
      if (!sub) throw new Error("Submission not found.");
      if (sub.status !== 'pending') throw new Error("Submission already verified.");

      if (action === 'approve') {
        // Credit reward to commission_balance
        await db.run("UPDATE users SET commission_balance = commission_balance + ? WHERE id = ?", [sub.reward, sub.user_id]);
        await db.run("UPDATE task_submissions SET status = 'approved' WHERE id = ?", [submissionId]);

        // Log transaction
        await db.run(
          "INSERT INTO transactions (user_id, type, amount, currency, status, details) VALUES (?, 'task_reward', ?, 'USD', 'approved', ?)",
          [sub.user_id, sub.reward, `Approved Task: ${sub.task_name}`]
        );
      } else {
        await db.run("UPDATE task_submissions SET status = 'rejected' WHERE id = ?", [submissionId]);
        // Log transaction
        await db.run(
          "INSERT INTO transactions (user_id, type, amount, currency, status, details) VALUES (?, 'task_reward', ?, 'USD', 'rejected', ?)",
          [sub.user_id, sub.reward, `Rejected Task: ${sub.task_name}`]
        );
      }
    });

    res.json({ message: `Task submission successfully ${action}d.` });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Get task configurations
router.get('/admin/task-configurations', authenticateAdmin, async (req, res) => {
  try {
    const configs = await db.all("SELECT * FROM task_configurations ORDER BY tier_id ASC");
    res.json(configs);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch task configurations." });
  }
});

// Save or update task configuration
router.post('/admin/task-configurations/save', authenticateAdmin, async (req, res) => {
  const { id, tier_id, display_name, payout, animation_delay, graphic_asset } = req.body;
  
  if (tier_id === undefined || !display_name || payout === undefined || animation_delay === undefined || !graphic_asset) {
    return res.status(400).json({ error: "All fields are required." });
  }

  try {
    if (id) {
      await db.run(
        `UPDATE task_configurations 
         SET tier_id = ?, display_name = ?, payout = ?, animation_delay = ?, graphic_asset = ? 
         WHERE id = ?`,
        [tier_id, display_name, parseFloat(payout), parseInt(animation_delay), graphic_asset, id]
      );
      res.json({ message: "Task configuration updated successfully." });
    } else {
      await db.run(
        `INSERT INTO task_configurations (tier_id, display_name, payout, animation_delay, graphic_asset) 
         VALUES (?, ?, ?, ?, ?)`,
        [tier_id, display_name, parseFloat(payout), parseInt(animation_delay), graphic_asset]
      );
      res.json({ message: "Task configuration created successfully." });
    }
  } catch (error) {
    res.status(500).json({ error: "Failed to save task configuration: " + error.message });
  }
});

// Delete task configuration
router.delete('/admin/task-configurations/delete/:id', authenticateAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    await db.run("DELETE FROM task_configurations WHERE id = ?", [id]);
    res.json({ message: "Task configuration deleted successfully." });
  } catch (error) {
    res.status(500).json({ error: "Failed to delete task configuration." });
  }
});

// Get labour logs with user freeze status
router.get('/admin/labour-logs', authenticateAdmin, async (req, res) => {
  try {
    const logs = await db.all(`
      SELECT l.*, u.status as user_status 
      FROM labour_logs l
      LEFT JOIN users u ON l.phone = u.phone
      ORDER BY l.id ASC
    `);
    res.json(logs);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch labour logs." });
  }
});

// Reset labour log execution status to In-Progress / Unchecked
router.post('/admin/labour-logs/reset', authenticateAdmin, async (req, res) => {
  const { logId } = req.body;
  try {
    await db.run("UPDATE labour_logs SET status = 'In-Progress / Unchecked' WHERE id = ?", [logId]);
    res.json({ message: "Labour log reset successfully." });
  } catch (error) {
    res.status(500).json({ error: "Failed to reset labour log." });
  }
});

export async function runGlobalMidnightReset() {
  console.log("[CRON] Running Global Midnight Reset Sequence...");
  try {
    const users = await db.all("SELECT id FROM users WHERE status = 'active'");
    for (const u of users) {
      await resetDailyTasksForUser(u.id);
    }
    console.log(`[CRON] Midnight reset completed successfully for ${users.length} users.`);
  } catch (error) {
    console.error("[CRON] Midnight reset sequence error:", error);
  }
}

// FORCE MANUALLY RESET GLOBAL DAILY TASKS
router.post('/admin/tasks/global-reset', authenticateAdmin, async (req, res) => {
  try {
    await runGlobalMidnightReset();
    res.json({ message: "Global daily tasks manual reset executed successfully across all user accounts." });
  } catch (error) {
    res.status(500).json({ error: "Failed to force global daily tasks reset: " + error.message });
  }
});

// Force Reset Counters for a specific user ID or Phone
router.post('/admin/tasks/reset-user', authenticateAdmin, async (req, res) => {
  const { userId, phone } = req.body;
  if (!userId && !phone) return res.status(400).json({ error: "User ID or phone is required." });

  try {
    let u;
    if (userId) {
      u = await db.get("SELECT id FROM users WHERE id = ?", [userId]);
    } else if (phone) {
      u = await db.get("SELECT id FROM users WHERE phone = ?", [phone]);
    }

    if (!u) {
      return res.status(404).json({ error: "User not found." });
    }

    await resetDailyTasksForUser(u.id);
    res.json({ message: `Successfully reset daily tasks and limits to full capacity for user.` });
  } catch (error) {
    res.status(500).json({ error: "Failed to reset user tasks: " + error.message });
  }
});
// Toggle user freeze status via labour logs phone number
router.post('/admin/labour-logs/toggle-freeze', authenticateAdmin, async (req, res) => {
  const { phone } = req.body;
  try {
    const user = await db.get("SELECT status FROM users WHERE phone = ?", [phone]);
    if (!user) {
      return res.status(404).json({ error: "User not found." });
    }
    const nextStatus = user.status === 'frozen' ? 'active' : 'frozen';
    await db.run("UPDATE users SET status = ? WHERE phone = ?", [nextStatus, phone]);
    res.json({ message: `User status changed to ${nextStatus}.`, status: nextStatus });
  } catch (error) {
    res.status(500).json({ error: "Failed to toggle user freeze status: " + error.message });
  }
});

// -------------------------------------------------------------
// ADMIN: ACTIVE INVESTMENT LEDGER
// -------------------------------------------------------------

// Get all user investment contracts with maturity dates (admin)
router.get('/admin/investments', authenticateAdmin, async (req, res) => {
  try {
    const investments = await db.all(`
      SELECT 
        c.id,
        c.user_id,
        u.phone,
        c.tier_name,
        c.price,
        c.daily_roi,
        c.duration_days,
        c.days_elapsed,
        c.total_returned,
        c.status,
        c.created_at,
        date(c.created_at, '+180 days') AS maturity_date
      FROM contracts c
      JOIN users u ON c.user_id = u.id
      WHERE c.user_id != 9999
      ORDER BY c.id DESC
      LIMIT 200
    `);
    res.json(investments);
  } catch (error) {
    res.status(500).json({ error: 'Failed to load investment ledger.' });
  }
});

// Force terminate (shutdown) a specific investment contract
router.post('/admin/investments/terminate', authenticateAdmin, async (req, res) => {
  const { contractId } = req.body;
  if (!contractId) return res.status(400).json({ error: 'Contract ID is required.' });

  try {
    await db.runTransaction(async () => {
      const contract = await db.get('SELECT * FROM contracts WHERE id = ?', [contractId]);
      if (!contract) throw new Error('Contract not found.');
      if (contract.status === 'terminated') throw new Error('Contract is already terminated.');

      // Mark contract as terminated
      await db.run("UPDATE contracts SET status = 'terminated' WHERE id = ?", [contractId]);

      // Log admin termination action
      await db.run(
        `INSERT INTO transactions (user_id, type, amount, currency, status, details)
         VALUES (?, 'admin_terminate', ?, 'USD', 'approved', ?)`,
        [contract.user_id, contract.price, `Admin Force Terminated Contract #${contractId} (${contract.tier_name})`]
      );
    });

    res.json({ message: `Contract #${contractId} has been force terminated.` });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// -------------------------------------------------------------
// ADMIN: PRODUCT CONFIGURATOR (Package CRUD)
// -------------------------------------------------------------

// Get all packages (admin — includes legacy)
router.get('/admin/packages', authenticateAdmin, async (req, res) => {
  try {
    const packages = await db.all('SELECT * FROM packages ORDER BY price ASC');
    res.json(packages);
  } catch (error) {
    res.status(500).json({ error: 'Failed to load packages.' });
  }
});

// Create or update a package
router.post('/admin/packages/save', authenticateAdmin, async (req, res) => {
  const { id, name, price, daily_return, total_return, price_bdt, daily_return_bdt, lock_days, graphic_type, description } = req.body;

  if (!id || !name || price === undefined || daily_return === undefined) {
    return res.status(400).json({ error: 'Package ID, name, price, and daily_return are required.' });
  }

  try {
    const existing = await db.get('SELECT id FROM packages WHERE id = ?', [id]);
    if (existing) {
      await db.run(
        `UPDATE packages SET name=?, price=?, daily_return=?, total_return=?, price_bdt=?, daily_return_bdt=?, lock_days=?, graphic_type=?, description=? WHERE id=?`,
        [name, parseFloat(price), parseFloat(daily_return), parseFloat(total_return || 0), parseFloat(price_bdt || 0),
         parseFloat(daily_return_bdt || 0), parseInt(lock_days || 180), graphic_type || '', description || '', id]
      );
      res.json({ message: 'Package updated successfully.' });
    } else {
      await db.run(
        `INSERT INTO packages (id, name, price, daily_return, total_return, price_bdt, daily_return_bdt, lock_days, graphic_type, description) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, name, parseFloat(price), parseFloat(daily_return), parseFloat(total_return || 0), parseFloat(price_bdt || 0),
         parseFloat(daily_return_bdt || 0), parseInt(lock_days || 180), graphic_type || '', description || '']
      );
      res.json({ message: 'Package created successfully.' });
    }
  } catch (error) {
    res.status(500).json({ error: 'Failed to save package: ' + error.message });
  }
});

// Delete a package
router.delete('/admin/packages/delete/:id', authenticateAdmin, async (req, res) => {
  const { id } = req.params;
  // Protect canonical tiers from deletion
  const protectedIds = ['free_starter','eco_mini','smart_home','solar_hub','agro_pump','wind_farm','hydro_plant','biomass_plant','data_center','gold_reserve'];
  if (protectedIds.includes(id)) {
    return res.status(400).json({ error: 'Cannot delete a canonical investment tier. Edit it instead.' });
  }
  try {
    await db.run('DELETE FROM packages WHERE id = ?', [id]);
    res.json({ message: 'Package deleted successfully.' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete package.' });
  }
});

export default router;
