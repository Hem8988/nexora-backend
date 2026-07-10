import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import { initDatabase, run, get } from './db.js';
import apiRouter, { runGlobalMidnightReset } from './routes.js';

const app = express();
const PORT = process.env.PORT || 5000;

// Enable CORS for frontend connectivity
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// Mount API Router
app.use('/api', apiRouter);

// Initialize DB and launch server
async function startServer() {
  try {
    await initDatabase();
    
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Nexora Backend API server running on http://localhost:${PORT}`);
    });

    // Start background activity simulation to feed the Telegram channel with mock actions
    startTelegramSocialSim();

    // Schedule midnight task reset cron
    scheduleMidnightCron();

  } catch (error) {
    console.error("Failed to start backend database:", error);
    process.exit(1);
  }
}

function scheduleMidnightCron() {
  const now = new Date();
  const nextMidnight = new Date(now);
  nextMidnight.setHours(24, 0, 0, 0); // 00:00 next day

  const msToMidnight = nextMidnight.getTime() - now.getTime();
  console.log(`[CRON] Scheduled global daily tasks reset. Next run in ${Math.round(msToMidnight / 1000 / 60)} minutes.`);

  setTimeout(async () => {
    try {
      await runGlobalMidnightReset();
    } catch (e) {
      console.error("[CRON ERROR] Global daily task reset failed:", e);
    }
    scheduleMidnightCron(); // Reschedule
  }, msToMidnight);
}

// Background simulator that spawns random user activity mock alerts to simulate high active user volume (DAU)
function startTelegramSocialSim() {
  const dummyBD = ['+88017', '+88019', '+88015', '+88018', '+88016'];
  const dummyIN = ['+9198', '+9199', '+9170', '+9180', '+9191'];
  
  setInterval(async () => {
    try {
      // Pick random country code and dummy numbers
      const isIndia = Math.random() > 0.5;
      const prefixes = isIndia ? dummyIN : dummyBD;
      const currency = 'USD';
      const suffix = Math.floor(1000 + Math.random() * 9000);
      const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
      const randomPhone = `${prefix}***${suffix}`;

      // Pick event
      const rand = Math.random();
      let type = '';
      let amount = 0;
      let details = '';

      if (rand < 0.4) {
        type = 'activate_contract';
        const packages = [10, 30, 70, 100, 300, 700, 1000];
        amount = packages[Math.floor(Math.random() * packages.length)];
        const names = [
          "Nexora Eco-Mini Grid", 
          "Nexora Smart Home Grid", 
          "Nexora Solar Community Hub", 
          "Nexora Agro-Solar Pump", 
          "Nexora Wind Farm Asset", 
          "Nexora Industrial Hydro-Plant", 
          "Nexora Biomass Power Plant"
        ];
        const tierName = names[packages.indexOf(amount)];
        details = `Activated ${tierName}`;
      } else if (rand < 0.8) {
        type = 'referral_comm';
        const commissions = [1, 2, 3, 4, 7, 10, 20];
        amount = commissions[Math.floor(Math.random() * commissions.length)];
        details = `Level commission from invite`;
      } else {
        type = 'withdrawal';
        amount = Math.floor(10 + Math.random() * 150);
        details = `Approved withdrawal transfer`;
      }

      // Check if we have dummy user to map this to, otherwise map to a special ID = 9999 (system mock)
      // We insert directly into transactions to seed the telegram feed
      // Using write locks
      await run(`
        INSERT INTO transactions (user_id, type, amount, currency, trx_id, channel, status, details) 
        VALUES (9999, ?, ?, ?, ?, ?, 'approved', ?)
      `, [
        type, 
        amount, 
        currency, 
        `MOCK-TRX-${Math.floor(Math.random() * 1000000)}`, 
        Math.random() > 0.5 ? 'bKash Payout' : 'Nagad Payout',
        `${randomPhone}: ${details}`
      ]);

      // Prune mock logs occasionally to prevent db bloat (> 100 mock transactions)
      await run(`
        DELETE FROM transactions 
        WHERE user_id = 9999 AND id NOT IN (
          SELECT id FROM transactions WHERE user_id = 9999 ORDER BY id DESC LIMIT 50
        )
      `);
      
    } catch (e) {
      // Ignore background errors
    }
  }, 35000); // Trigger mock activity updates every 35 seconds
}

// Seed system user for mocks
async function seedMockSystemUser() {
  try {
    const exists = await run("SELECT id FROM users WHERE id = 9999");
    if (!exists || exists.changes === 0) {
      await run(`
        INSERT OR IGNORE INTO users (id, phone, password_hash, country_code, currency, referral_code, status, created_ip)
        VALUES (9999, 'SYSTEM_BOT', 'N/A', 'N/A', 'N/A', 'BOT', 'active', '127.0.0.1')
      `);
    }
  } catch (err) {
    // Ignore
  }
}

// Seed default test user for quick evaluation
async function seedDefaultTestUser() {
  try {
    const exists = await get("SELECT id FROM users WHERE phone = ?", ['+8801700000010']);
    if (!exists) {
      const salt = await bcrypt.genSalt(10);
      const passwordHash = await bcrypt.hash("testpass123", salt);
      await run(`
        INSERT INTO users (phone, password_hash, country_code, currency, total_balance, deposit_balance, commission_balance, referral_code, status, created_ip)
        VALUES ('+8801700000010', ?, '+880', 'USD', 500.0, 100.0, 50.0, 'NEX-TEST-880', 'active', '127.0.0.1')
      `, [passwordHash]);
      console.log("Seeded default test user (+8801700000010) successfully in USD.");
    }
  } catch (err) {
    console.error("Seeding default test user failed:", err);
  }
}

// Run the application
startServer().then(async () => {
  await seedMockSystemUser();
  await seedDefaultTestUser();
});
