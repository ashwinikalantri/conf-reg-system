const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.resolve(__dirname, 'conference.db');
const db = new sqlite3.Database(dbPath);

function initDatabase() {
  db.serialize(() => {
    // 1. Users Table
    db.run(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        phone_number TEXT UNIQUE NOT NULL,
        full_name TEXT NOT NULL,
        designation TEXT,
        institution TEXT,
        pincode TEXT,
        state TEXT,
        district TEXT,
        post_office TEXT,
        role TEXT DEFAULT 'DELEGATE',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 2. OTP Verifications Table
    db.run(`
      CREATE TABLE IF NOT EXISTS otp_verifications (
        id TEXT PRIMARY KEY,
        phone_number TEXT NOT NULL,
        otp_code TEXT NOT NULL,
        expires_at DATETIME NOT NULL,
        is_verified INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 3. Registrations & Payments Table (Default Status = PENDING)
    db.run(`
      CREATE TABLE IF NOT EXISTS registrations (
        id TEXT PRIMARY KEY,
        registration_code TEXT UNIQUE NOT NULL,
        user_phone TEXT NOT NULL,
        delegate_name TEXT NOT NULL,
        category_key TEXT NOT NULL,
        category_label TEXT NOT NULL,
        workshop_preference TEXT NOT NULL,
        qi_exposure_preference TEXT NOT NULL,
        expected_amount REAL NOT NULL,
        paid_amount REAL NOT NULL,
        utr_number TEXT NOT NULL,
        vpa_target TEXT DEFAULT 'abhishekraut@cbin',
        ocr_utr_match INTEGER DEFAULT 0,
        ocr_amount_match INTEGER DEFAULT 0,
        ocr_vpa_match INTEGER DEFAULT 0,
        bank_status TEXT DEFAULT 'PENDING',
        audit_notes TEXT DEFAULT '',
        submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 4. Abstract Submissions Table
    db.run(`
      CREATE TABLE IF NOT EXISTS abstracts (
        id TEXT PRIMARY KEY,
        abstract_code TEXT UNIQUE NOT NULL,
        author_phone TEXT NOT NULL,
        author_name TEXT NOT NULL,
        presentation_format TEXT NOT NULL,
        title TEXT NOT NULL,
        abstract_text TEXT NOT NULL,
        word_count INTEGER NOT NULL,
        status TEXT DEFAULT 'UNDER_REVIEW',
        review_comments TEXT DEFAULT '',
        submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Seed default administrative and demo accounts on first run
    db.get("SELECT COUNT(*) AS count FROM users", (err, row) => {
      if (err) return console.error("Database seed check failed:", err.message);

      if (row.count === 0) {
        console.log("Database initialized for first run. Seeding default roles...");
        const stmt = db.prepare(`
          INSERT INTO users (id, phone_number, full_name, designation, institution, role)
          VALUES (?, ?, ?, ?, ?, ?)
        `);

        stmt.run('u-1', '9999999999', 'Dr. Admin Chief', 'Organizing Chair', 'MGIMS Sevagram', 'SUPER_ADMIN');
        stmt.run('u-2', '8888888888', 'Suresh Finance Desk', 'Finance Officer', 'MGIMS Sevagram', 'FINANCE_ADMIN');
        stmt.run('u-3', '7777777777', 'Prof. Academic Reviewer', 'Scientific Committee', 'MGIMS Sevagram', 'ACADEMIC_REVIEWER');
        stmt.run('u-4', '9876543210', 'Dr. Ananya Sharma', 'PG Resident', 'AIIMS Nagpur', 'DELEGATE');
        stmt.finalize();

        // Seed demo registration in PENDING status
        db.run(`
          INSERT INTO registrations 
          (id, registration_code, user_phone, delegate_name, category_key, category_label, workshop_preference, qi_exposure_preference, expected_amount, paid_amount, utr_number, bank_status)
          VALUES ('p-1', 'PAY-1001', '9876543210', 'Dr. Ananya Sharma', 'pg_doctor', 'PG Student / Resident Doctor', 'WS 1: POCQI Methodology', 'Exposure A: Neonatal ICU', 3000, 3000, '329841029384', 'PENDING')
        `);

        console.log("Default administrative users and demo records created.");
      }
    });
  });
}

initDatabase();

module.exports = db;