const express = require('express');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const PORT = process.env.PORT || 3000;

// Increase request body limit to 50MB for Base64 image payload handling
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

app.use(express.static(path.join(__dirname, 'public')));

// Database setup
const db = new sqlite3.Database('./conference.db', (err) => {
  if (err) console.error('Error connecting to SQLite:', err);
  else console.log('Connected to SQLite database.');
});

// Initialize Tables
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      phone_number TEXT PRIMARY KEY,
      full_name TEXT,
      designation TEXT,
      institution TEXT,
      pincode TEXT,
      state TEXT,
      district TEXT,
      post_office TEXT,
      role TEXT DEFAULT 'DELEGATE'
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS registrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone_number TEXT UNIQUE,
      delegate_name TEXT,
      category_key TEXT,
      category_label TEXT,
      workshop TEXT,
      qi_exposure TEXT,
      paid_amount REAL,
      utr_number TEXT,
      screenshot TEXT,
      is_flagged INTEGER DEFAULT 0,
      bank_status TEXT DEFAULT 'PENDING'
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS abstracts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone_number TEXT,
      author_name TEXT,
      format TEXT,
      title TEXT,
      text TEXT,
      word_count INTEGER
    )
  `);
});

// --- API ENDPOINTS ---

// Mock OTP Request
app.post('/api/otp/request', (req, res) => {
  const { phone } = req.body;
  if (!phone || phone.length !== 10) {
    return res.status(400).json({ success: false, error: 'Invalid phone number.' });
  }
  const demoOTP = '123456';
  res.json({ success: true, demoOTP });
});

// User Registration
app.post('/api/auth/register', (req, res) => {
  const { phone, otp, name, designation, institute, pincode, state, district, po } = req.body;
  if (otp !== '123456') {
    return res.status(400).json({ success: false, error: 'Invalid OTP entered.' });
  }

  const sql = `INSERT INTO users (phone_number, full_name, designation, institution, pincode, state, district, post_office, role) 
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'DELEGATE')
               ON CONFLICT(phone_number) DO UPDATE SET 
               full_name=excluded.full_name, designation=excluded.designation, institution=excluded.institution`;
               
  db.run(sql, [phone, name, designation, institute, pincode, state, district, po], function(err) {
    if (err) return res.status(500).json({ success: false, error: err.message });
    res.json({ success: true, user: { phone_number: phone, name, designation, institute, role: 'DELEGATE' } });
  });
});

// User Login
app.post('/api/auth/login', (req, res) => {
  const { phone, otp } = req.body;
  if (otp !== '123456') {
    return res.status(400).json({ success: false, error: 'Invalid OTP.' });
  }

  db.get(`SELECT * FROM users WHERE phone_number = ?`, [phone], (err, row) => {
    if (err || !row) return res.status(404).json({ success: false, error: 'Mobile number not registered.' });
    res.json({ success: true, user: row });
  });
});

// Submit Payment Registration
app.post('/api/registrations', (req, res) => {
  const { phone, delegateName, categoryKey, categoryLabel, workshop, qiExposure, amount, utr, screenshot, isFlagged } = req.body;

  if (!phone || !utr || !screenshot) {
    return res.status(400).json({ success: false, error: 'Missing required registration details.' });
  }

  const sql = `INSERT INTO registrations 
    (phone_number, delegate_name, category_key, category_label, workshop, qi_exposure, paid_amount, utr_number, screenshot, is_flagged, bank_status) 
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING')
    ON CONFLICT(phone_number) DO UPDATE SET 
    category_key=excluded.category_key,
    category_label=excluded.category_label,
    workshop=excluded.workshop,
    qi_exposure=excluded.qi_exposure,
    paid_amount=excluded.paid_amount,
    utr_number=excluded.utr_number,
    screenshot=excluded.screenshot,
    is_flagged=excluded.is_flagged,
    bank_status='PENDING'`;

  db.run(sql, [phone, delegateName, categoryKey, categoryLabel, workshop, qiExposure, amount, utr, screenshot, isFlagged ? 1 : 0], function(err) {
    if (err) {
      console.error("Database Insert Error:", err);
      return res.status(500).json({ success: false, error: 'Database save failed.' });
    }
    res.json({ success: true, id: this.lastID });
  });
});

// Fetch Single User Registration
app.get('/api/registrations/user/:phone', (req, res) => {
  db.get(`SELECT * FROM registrations WHERE phone_number = ?`, [req.params.phone], (err, row) => {
    res.json({ registration: row || null });
  });
});

// Fetch All Registrations (Admin)
app.get('/api/registrations', (req, res) => {
  db.all(`SELECT * FROM registrations ORDER BY id DESC`, [], (err, rows) => {
    res.json({ registrations: rows || [] });
  });
});

// Update Bank Verification Status (Admin)
app.put('/api/registrations/:id/status', (req, res) => {
  const { bankStatus } = req.body;
  db.run(`UPDATE registrations SET bank_status = ? WHERE id = ?`, [bankStatus, req.params.id], function(err) {
    if (err) return res.status(500).json({ success: false, error: err.message });
    res.json({ success: true });
  });
});

// Fetch Users List (Admin)
app.get('/api/users', (req, res) => {
  db.all(`SELECT * FROM users`, [], (err, rows) => {
    res.json({ users: rows || [] });
  });
});

// Admin Manual Create User
app.post('/api/users', (req, res) => {
  const { name, phone, designation, institute, role } = req.body;
  const sql = `INSERT INTO users (phone_number, full_name, designation, institution, role) VALUES (?, ?, ?, ?, ?)`;
  db.run(sql, [phone, name, designation, institute, role], function(err) {
    if (err) return res.status(500).json({ success: false, error: err.message });
    res.json({ success: true });
  });
});

// Update User Role (Admin)
app.put('/api/users/:phone/role', (req, res) => {
  const { role } = req.body;
  db.run(`UPDATE users SET role = ? WHERE phone_number = ?`, [role, req.params.phone], function(err) {
    res.json({ success: true });
  });
});

// Abstract Submission
app.post('/api/abstracts', (req, res) => {
  const { phone, authorName, format, title, text, wordCount } = req.body;
  const sql = `INSERT INTO abstracts (phone_number, author_name, format, title, text, word_count) VALUES (?, ?, ?, ?, ?, ?)`;
  db.run(sql, [phone, authorName, format, title, text, wordCount], function(err) {
    if (err) return res.status(500).json({ success: false, error: err.message });
    res.json({ success: true });
  });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});