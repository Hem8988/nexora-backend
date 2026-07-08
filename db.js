import sqlite3 from 'sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, 'nexora.db');

const db = new sqlite3.Database(dbPath);

// Enable serialized mode to prevent concurrency issues out-of-the-box
db.serialize();

// Helper to execute raw runs (INSERT, UPDATE, DELETE)
export function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ id: this.lastID, changes: this.changes });
    });
  });
}

// Helper to fetch one row
export function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

// Helper to fetch all rows
export function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

// High-integrity Database Transaction execution
// Starts an IMMEDIATE write lock transaction to prevent double spending
export async function runTransaction(callback) {
  return new Promise((resolve, reject) => {
    db.serialize(async () => {
      try {
        await run("BEGIN IMMEDIATE TRANSACTION");
        const result = await callback();
        await run("COMMIT");
        resolve(result);
      } catch (err) {
        // Attempt rollback, then reject
        db.run("ROLLBACK", () => {
          reject(err);
        });
      }
    });
  });
}

// Initialize tables and seed settings
export async function initDatabase() {
  // Users Table
  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      country_code TEXT NOT NULL,
      currency TEXT NOT NULL,
      balance REAL DEFAULT 0.0,
      vault_balance REAL DEFAULT 0.0,
      vault_locked_until TEXT,
      referral_code TEXT UNIQUE NOT NULL,
      referred_by INTEGER,
      status TEXT DEFAULT 'active',
      created_ip TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(referred_by) REFERENCES users(id)
    )
  `);

  // Contracts (Asset Units)
  await run(`
    CREATE TABLE IF NOT EXISTS contracts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      tier_name TEXT NOT NULL,
      price REAL NOT NULL,
      daily_roi REAL NOT NULL,
      duration_days INTEGER NOT NULL,
      days_elapsed INTEGER DEFAULT 0,
      last_claimed_at TEXT,
      total_returned REAL DEFAULT 0.0,
      status TEXT DEFAULT 'active',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);

  // Transactions & Deposits
  await run(`
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      amount REAL NOT NULL,
      currency TEXT NOT NULL,
      trx_id TEXT UNIQUE,
      channel TEXT,
      status TEXT DEFAULT 'pending',
      details TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);

  // Referral Commissions History
  await run(`
    CREATE TABLE IF NOT EXISTS commissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      upline_user_id INTEGER NOT NULL,
      downline_user_id INTEGER NOT NULL,
      contract_id INTEGER NOT NULL,
      level INTEGER NOT NULL,
      amount REAL NOT NULL,
      currency TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(upline_user_id) REFERENCES users(id),
      FOREIGN KEY(downline_user_id) REFERENCES users(id),
      FOREIGN KEY(contract_id) REFERENCES contracts(id)
    )
  `);

  // Settings
  await run(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  // Alter users table to support the new columns if they do not exist
  const addColumn = async (columnDef) => {
    try {
      await run(`ALTER TABLE users ADD COLUMN ${columnDef}`);
    } catch (e) {
      // Ignored: Column already exists
    }
  };
  await addColumn("deposit_balance REAL DEFAULT 0.0");
  await addColumn("commission_balance REAL DEFAULT 0.0");
  await addColumn("pending_commission REAL DEFAULT 0.0");
  await addColumn("email TEXT");
  await addColumn("full_name TEXT");
  await addColumn("total_balance REAL DEFAULT 0.0");
  await addColumn("level1_pending_comm REAL DEFAULT 0.0");
  await addColumn("level2_pending_comm REAL DEFAULT 0.0");
  await addColumn("level3_pending_comm REAL DEFAULT 0.0");
  await addColumn("claimed_milestones TEXT DEFAULT ''");
  await addColumn("milestone_recruitment_claimed INTEGER DEFAULT 0");
  await addColumn("avatar TEXT");

  // Create dynamic vault_locks table
  await run(`
    CREATE TABLE IF NOT EXISTS vault_locks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      amount REAL NOT NULL,
      duration_days INTEGER NOT NULL,
      bonus_pct REAL NOT NULL,
      unlock_date TEXT NOT NULL,
      status TEXT DEFAULT 'locked',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);

  // Create task submissions table
  await run(`
    CREATE TABLE IF NOT EXISTS task_submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      task_name TEXT NOT NULL,
      proof_image TEXT,
      status TEXT DEFAULT 'pending',
      reward REAL NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);

  // Create packages table
  await run(`
    CREATE TABLE IF NOT EXISTS packages (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      price REAL NOT NULL,
      daily_return REAL NOT NULL,
      lock_days INTEGER NOT NULL
    )
  `);

  // Seed default packages/tiers (including legacy packages for test suite compatibility)
  const defaultPkgs = [
    { id: 'eco_mini', name: "Nexora Eco-Mini Grid", price: 10, daily_return: 0.35, lock_days: 180 },
    { id: 'smart_home', name: "Nexora Smart Home Grid", price: 30, daily_return: 1.10, lock_days: 180 },
    { id: 'solar_hub', name: "Nexora Solar Community Hub", price: 70, daily_return: 2.70, lock_days: 180 },
    { id: 'agro_pump', name: "Nexora Agro-Solar Pump", price: 100, daily_return: 4.00, lock_days: 180 },
    { id: 'wind_farm', name: "Nexora Wind Farm Asset", price: 300, daily_return: 13.00, lock_days: 180 },
    { id: 'hydro_plant', name: "Nexora Industrial Hydro-Plant", price: 700, daily_return: 32.00, lock_days: 180 },
    { id: 'biomass_plant', name: "Nexora Biomass Power Plant", price: 1000, daily_return: 48.00, lock_days: 180 },
    { id: 'data_center', name: "Nexora Green Data Center", price: 5000, daily_return: 260.00, lock_days: 180 },
    { id: 'gold_reserve', name: "Nexora Gold Refinery Reserve", price: 10000, daily_return: 550.00, lock_days: 180 },
    { id: 'energy_matrix', name: "Nexora Sovereign Energy Matrix", price: 50000, daily_return: 3000.00, lock_days: 180 },
    
    // Legacy BDT/INR package configurations for automated test suite compatibility
    { id: 'solar', name: "Solar Power Grid", price: 1000, daily_return: 30.00, lock_days: 180 },
    { id: 'wind', name: "Wind Turbine Project", price: 5000, daily_return: 160.00, lock_days: 180 },
    { id: 'biomass', name: "Biomass Energy Plant", price: 15000, daily_return: 510.00, lock_days: 180 },
    { id: 'lithium', name: "Lithium Battery Refinery", price: 4000, daily_return: 144.00, lock_days: 180 },
    { id: 'gold', name: "Gold Refining Facility", price: 100000, daily_return: 3800.00, lock_days: 180 }
  ];

  for (const pkg of defaultPkgs) {
    await run("INSERT OR IGNORE INTO packages (id, name, price, daily_return, lock_days) VALUES (?, ?, ?, ?, ?)", [
      pkg.id, pkg.name, pkg.price, pkg.daily_return, pkg.lock_days
    ]);
  }

  // Seed default configuration settings if not present
  const seed = async (key, defaultValue) => {
    const existing = await get("SELECT value FROM settings WHERE key = ?", [key]);
    if (!existing) {
      await run("INSERT INTO settings (key, value) VALUES (?, ?)", [key, defaultValue]);
    }
  };

  await seed('withdrawal_fee_pct', '10');
  await seed('min_withdrawal_bdt', '500');
  await seed('min_withdrawal_inr', '400');
  await seed('min_withdrawal_usd', '5');
  await seed('global_freeze', '0');

  // Create task configurations table
  await run(`
    CREATE TABLE IF NOT EXISTS task_configurations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tier_id INTEGER UNIQUE NOT NULL,
      display_name TEXT NOT NULL,
      payout REAL NOT NULL,
      animation_delay INTEGER NOT NULL,
      graphic_asset TEXT NOT NULL
    )
  `);

  // Create labour logs table
  await run(`
    CREATE TABLE IF NOT EXISTS labour_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL,
      tier_name TEXT NOT NULL,
      task_instance TEXT NOT NULL,
      status TEXT NOT NULL,
      timestamp TEXT NOT NULL
    )
  `);

  // Seed default configurations
  const defaultTaskConfigs = [
    { tier_id: 0, display_name: "Match Eco-Grid Order", payout: 21.33, animation_delay: 5, graphic_asset: "eco_grid_order.glb" },
    { tier_id: 1, display_name: "Verify Wind Turbine Dispatch", payout: 23.75, animation_delay: 6, graphic_asset: "wind_turbine.glb" },
    { tier_id: 2, display_name: "Validate Hydro Flow Metrics", payout: 26.40, animation_delay: 7, graphic_asset: "hydro_flow.glb" },
    { tier_id: 3, display_name: "Inspect Solar Panel Array", payout: 29.85, animation_delay: 6, graphic_asset: "solar_panel_array.glb" },
    { tier_id: 4, display_name: "Check Battery Storage Unit", payout: 33.20, animation_delay: 8, graphic_asset: "battery_storage.glb" }
  ];

  for (const config of defaultTaskConfigs) {
    await run(`
      INSERT OR IGNORE INTO task_configurations (tier_id, display_name, payout, animation_delay, graphic_asset)
      VALUES (?, ?, ?, ?, ?)
    `, [config.tier_id, config.display_name, config.payout, config.animation_delay, config.graphic_asset]);
  }

  // Seed labour logs (6 items shown in screenshot)
  const defaultLabourLogs = [
    { phone: "+1 (555) 123-4567", tier_name: "Tier 4: Agro-Solar Pump", task_instance: "Task #2 of 5", status: "In-Progress / Unchecked", timestamp: "2025-05-10 14:23:45.123456" },
    { phone: "+1 (555) 987-6543", tier_name: "Tier 3: Wind Energy Node", task_instance: "Task #5 of 5", status: "Successfully Processed", timestamp: "2025-05-10 14:23:44.654321" },
    { phone: "+1 (555) 222-3333", tier_name: "Tier 2: Hydro Power Unit", task_instance: "Task #1 of 5", status: "In-Progress / Unchecked", timestamp: "2025-05-10 14:23:43.987654" },
    { phone: "+1 (555) 444-5555", tier_name: "Tier 5: Biofuel Processor", task_instance: "Task #3 of 5", status: "Successfully Processed", timestamp: "2025-05-10 14:23:43.456789" },
    { phone: "+1 (555) 666-7777", tier_name: "Tier 1: Smart Grid Monitor", task_instance: "Task #4 of 5", status: "In-Progress / Unchecked", timestamp: "2025-05-10 14:23:43.123987" },
    { phone: "+1 (555) 888-9999", tier_name: "Tier 0: System Onboarding", task_instance: "Task #1 of 5", status: "Successfully Processed", timestamp: "2025-05-10 14:23:42.789654" }
  ];

  for (const log of defaultLabourLogs) {
    const logExists = await get(`
      SELECT id FROM labour_logs 
      WHERE phone = ? AND tier_name = ? AND task_instance = ? AND timestamp = ?
    `, [log.phone, log.tier_name, log.task_instance, log.timestamp]);
    if (!logExists) {
      await run(`
        INSERT INTO labour_logs (phone, tier_name, task_instance, status, timestamp)
        VALUES (?, ?, ?, ?, ?)
      `, [log.phone, log.tier_name, log.task_instance, log.status, log.timestamp]);
    }

    const userExists = await get("SELECT id FROM users WHERE phone = ?", [log.phone]);
    if (!userExists) {
      const dummyRefCode = "REF-" + log.phone.replace(/\D/g, '');
      await run(`
        INSERT INTO users (phone, password_hash, country_code, currency, total_balance, deposit_balance, commission_balance, referral_code, status, created_ip)
        VALUES (?, 'DUMMY_HASH', '+1', 'USD', 1283.45, 100.0, 50.0, ?, 'active', '127.0.0.1')
      `, [log.phone, dummyRefCode]);
    }
  }

  console.log("Database initialized and default settings verified.");
}

export default {
  run,
  get,
  all,
  runTransaction,
  initDatabase
};
