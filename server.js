require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend/build')));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});
const JWT_SECRET = process.env.JWT_SECRET || 'schoolfee-secret-2025';

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY, username VARCHAR(100) UNIQUE NOT NULL,
      password VARCHAR(255) NOT NULL, school_name VARCHAR(200) DEFAULT 'My School',
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS students (
      id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      name VARCHAR(200) NOT NULL, father_name VARCHAR(200), mother_name VARCHAR(200),
      phone VARCHAR(20), class VARCHAR(50), section VARCHAR(10),
      total_fee NUMERIC(10,2) DEFAULT 0, paid_fee NUMERIC(10,2) DEFAULT 0,
      last_paid DATE, created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS messages_log (
      id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      student_id INTEGER REFERENCES students(id) ON DELETE CASCADE,
      message_type VARCHAR(50), sent_at TIMESTAMP DEFAULT NOW(), status VARCHAR(20) DEFAULT 'sent'
    );
    CREATE TABLE IF NOT EXISTS settings (
      id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE UNIQUE,
      school_name VARCHAR(200), wa_phone_id VARCHAR(100), wa_token TEXT,
      wa_cc VARCHAR(10) DEFAULT '+91', tpl_due TEXT, tpl_confirm TEXT, tpl_statement TEXT, tpl_custom TEXT
    );
    CREATE TABLE IF NOT EXISTS expenses (
      id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      date DATE NOT NULL DEFAULT CURRENT_DATE, category VARCHAR(100) NOT NULL,
      description TEXT, amount NUMERIC(10,2) NOT NULL, type VARCHAR(10) DEFAULT 'expense',
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log('Database ready');
}

function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid token' }); }
}

app.post('/api/register', async (req, res) => {
  const { username, password, school_name } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query('INSERT INTO users (username,password,school_name) VALUES ($1,$2,$3) RETURNING id,username,school_name', [username.toLowerCase(), hash, school_name || 'My School']);
    const user = result.rows[0];
    await pool.query('INSERT INTO settings (user_id,school_name,tpl_due,tpl_confirm,tpl_statement,tpl_custom) VALUES ($1,$2,$3,$4,$5,$6)',
      [user.id, school_name || 'My School',
        'Dear {name}\'s parent,\n\nThis is a reminder that Rs.{due} is pending for {name} ({class}) at {school}.\n\nTotal: Rs.{total} | Paid: Rs.{paid} | Due: Rs.{due}\n\nPlease clear dues at your earliest.\n\nThank you,\n{school}',
        'Dear {name}\'s parent,\n\nPayment of Rs.{paid} received for {name} ({class}) at {school}.\n\nTotal: Rs.{total} | Paid: Rs.{paid} | Balance: Rs.{due}\n\nThank you!\n\n{school}',
        'Dear Parent,\n\nFee Statement for {name} ({class})\n{school}\n\nTotal Fee: Rs.{total}\nPaid: Rs.{paid}\nDue: Rs.{due}\n\nRegards,\n{school}',
        'Dear {name}\'s parent,\n\nImportant message from {school} regarding {name} ({class}).\n\n[Add your message here]\n\nThank you,\n{school}'
      ]);
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user });
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Username already taken' });
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE username=$1', [username.toLowerCase()]);
    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(password, user.password))) return res.status(401).json({ error: 'Invalid username or password' });
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: user.id, username: user.username, school_name: user.school_name } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/students', auth, async (req, res) => { const r = await pool.query('SELECT * FROM students WHERE user_id=$1 ORDER BY name', [req.user.id]); res.json(r.rows); });
app.post('/api/students', auth, async (req, res) => {
  const { name, father_name, mother_name, phone, class: cls, section, total_fee, paid_fee } = req.body;
  const r = await pool.query('INSERT INTO students (user_id,name,father_name,mother_name,phone,class,section,total_fee,paid_fee) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *', [req.user.id, name, father_name, mother_name, phone, cls, section, total_fee || 0, paid_fee || 0]);
  res.json(r.rows[0]);
});
app.put('/api/students/:id', auth, async (req, res) => {
  const { name, father_name, mother_name, phone, class: cls, section, total_fee, paid_fee, last_paid } = req.body;
  const r = await pool.query('UPDATE students SET name=$1,father_name=$2,mother_name=$3,phone=$4,class=$5,section=$6,total_fee=$7,paid_fee=$8,last_paid=$9 WHERE id=$10 AND user_id=$11 RETURNING *', [name, father_name, mother_name, phone, cls, section, total_fee, paid_fee, last_paid, req.params.id, req.user.id]);
  res.json(r.rows[0]);
});
app.delete('/api/students/:id', auth, async (req, res) => { await pool.query('DELETE FROM students WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]); res.json({ success: true }); });
app.post('/api/students/:id/payment', auth, async (req, res) => {
  const { amount, date } = req.body;
  const s = await pool.query('SELECT * FROM students WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
  if (!s.rows[0]) return res.status(404).json({ error: 'Not found' });
  const newPaid = Math.min(parseFloat(s.rows[0].total_fee), parseFloat(s.rows[0].paid_fee) + parseFloat(amount));
  const r = await pool.query('UPDATE students SET paid_fee=$1,last_paid=$2 WHERE id=$3 RETURNING *', [newPaid, date || new Date().toISOString().split('T')[0], req.params.id]);
  res.json(r.rows[0]);
});

// ── Expenses ──────────────────────────────────────────────────────────────────
app.get('/api/expenses', auth, async (req, res) => {
  const { month, year } = req.query;
  let q = 'SELECT * FROM expenses WHERE user_id=$1'; const p = [req.user.id];
  if (month && year) { q += ' AND EXTRACT(MONTH FROM date)=$2 AND EXTRACT(YEAR FROM date)=$3'; p.push(month, year); }
  q += ' ORDER BY date DESC, created_at DESC';
  const r = await pool.query(q, p); res.json(r.rows);
});
app.post('/api/expenses', auth, async (req, res) => {
  const { date, category, description, amount, type } = req.body;
  if (!category || !amount) return res.status(400).json({ error: 'Category and amount required' });
  const r = await pool.query('INSERT INTO expenses (user_id,date,category,description,amount,type) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', [req.user.id, date || new Date().toISOString().split('T')[0], category, description, amount, type || 'expense']);
  res.json(r.rows[0]);
});
app.put('/api/expenses/:id', auth, async (req, res) => {
  const { date, category, description, amount, type } = req.body;
  const r = await pool.query('UPDATE expenses SET date=$1,category=$2,description=$3,amount=$4,type=$5 WHERE id=$6 AND user_id=$7 RETURNING *', [date, category, description, amount, type, req.params.id, req.user.id]);
  res.json(r.rows[0]);
});
app.delete('/api/expenses/:id', auth, async (req, res) => { await pool.query('DELETE FROM expenses WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]); res.json({ success: true }); });

// ── Balance Sheet ─────────────────────────────────────────────────────────────
app.get('/api/balancesheet', auth, async (req, res) => {
  const y = req.query.year || new Date().getFullYear();
  const [fees, exps] = await Promise.all([
    pool.query(`SELECT EXTRACT(MONTH FROM last_paid) as month, SUM(paid_fee) as total FROM students WHERE user_id=$1 AND last_paid IS NOT NULL AND EXTRACT(YEAR FROM last_paid)=$2 GROUP BY month`, [req.user.id, y]),
    pool.query(`SELECT EXTRACT(MONTH FROM date) as month, type, SUM(amount) as total FROM expenses WHERE user_id=$1 AND EXTRACT(YEAR FROM date)=$2 GROUP BY month,type`, [req.user.id, y])
  ]);
  const months = Array.from({length:12},(_,i)=>({month:i+1,fee_income:0,other_income:0,expense:0}));
  fees.rows.forEach(r => { months[parseInt(r.month)-1].fee_income = parseFloat(r.total); });
  exps.rows.forEach(r => { const m = months[parseInt(r.month)-1]; if(r.type==='income') m.other_income+=parseFloat(r.total); else m.expense+=parseFloat(r.total); });
  months.forEach(m => { m.total_income = m.fee_income + m.other_income; m.balance = m.total_income - m.expense; });
  res.json({ year: y, months });
});

// ── Stats ─────────────────────────────────────────────────────────────────────
app.get('/api/stats', auth, async (req, res) => {
  const [s, msgs, exps] = await Promise.all([
    pool.query('SELECT COUNT(*) as total,SUM(total_fee) as total_fee,SUM(paid_fee) as paid_fee FROM students WHERE user_id=$1', [req.user.id]),
    pool.query('SELECT COUNT(*) as sent FROM messages_log WHERE user_id=$1', [req.user.id]),
    pool.query(`SELECT SUM(amount) FILTER(WHERE type='expense') as total_expense, SUM(amount) FILTER(WHERE type='income') as other_income FROM expenses WHERE user_id=$1`, [req.user.id])
  ]);
  res.json({ total_students:parseInt(s.rows[0].total), total_fee:parseFloat(s.rows[0].total_fee)||0, paid_fee:parseFloat(s.rows[0].paid_fee)||0, due_fee:(parseFloat(s.rows[0].total_fee)||0)-(parseFloat(s.rows[0].paid_fee)||0), messages_sent:parseInt(msgs.rows[0].sent), total_expense:parseFloat(exps.rows[0].total_expense)||0 });
});

app.get('/api/settings', auth, async (req, res) => { const r = await pool.query('SELECT * FROM settings WHERE user_id=$1', [req.user.id]); res.json(r.rows[0] || {}); });
app.put('/api/settings', auth, async (req, res) => {
  const { school_name, wa_phone_id, wa_token, wa_cc, tpl_due, tpl_confirm, tpl_statement, tpl_custom } = req.body;
  await pool.query('UPDATE settings SET school_name=$1,wa_phone_id=$2,wa_token=$3,wa_cc=$4,tpl_due=$5,tpl_confirm=$6,tpl_statement=$7,tpl_custom=$8 WHERE user_id=$9', [school_name, wa_phone_id, wa_token, wa_cc, tpl_due, tpl_confirm, tpl_statement, tpl_custom, req.user.id]);
  await pool.query('UPDATE users SET school_name=$1 WHERE id=$2', [school_name, req.user.id]);
  res.json({ success: true });
});

app.post('/api/whatsapp/send', auth, async (req, res) => {
  const { student_id, template_type } = req.body;
  const [sR, cR] = await Promise.all([pool.query('SELECT * FROM students WHERE id=$1 AND user_id=$2', [student_id, req.user.id]), pool.query('SELECT * FROM settings WHERE user_id=$1', [req.user.id])]);
  const student = sR.rows[0]; const cfg = cR.rows[0];
  if (!student) return res.status(404).json({ error: 'Student not found' });
  if (!cfg?.wa_phone_id || !cfg?.wa_token) return res.status(400).json({ error: 'WhatsApp API not configured' });
  const due = Math.max(0, parseFloat(student.total_fee) - parseFloat(student.paid_fee));
  const tMap = {due:cfg.tpl_due,confirm:cfg.tpl_confirm,statement:cfg.tpl_statement,custom:cfg.tpl_custom};
  const body = (tMap[template_type]||cfg.tpl_due).replace(/{name}/g,student.name).replace(/{class}/g,student.class||'').replace(/{father}/g,student.father_name||'').replace(/{mother}/g,student.mother_name||'').replace(/{total}/g,parseFloat(student.total_fee).toLocaleString('en-IN')).replace(/{paid}/g,parseFloat(student.paid_fee).toLocaleString('en-IN')).replace(/{due}/g,due.toLocaleString('en-IN')).replace(/{school}/g,cfg.school_name||'School');
  const phone = (cfg.wa_cc||'+91').replace('+','') + student.phone.replace(/\D/g,'');
  try {
    await axios.post(`https://graph.facebook.com/v18.0/${cfg.wa_phone_id}/messages`, {messaging_product:'whatsapp',to:phone,type:'text',text:{body}}, {headers:{Authorization:`Bearer ${cfg.wa_token}`,'Content-Type':'application/json'}});
    await pool.query('INSERT INTO messages_log (user_id,student_id,message_type) VALUES ($1,$2,$3)', [req.user.id, student_id, template_type]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.response?.data?.error?.message || e.message }); }
});

app.get('/api/export', auth, async (req, res) => {
  const r = await pool.query('SELECT * FROM students WHERE user_id=$1 ORDER BY name', [req.user.id]);
  const headers = ['Name','Father','Mother','Phone','Class','Section','Total Fee','Paid','Due','Last Paid'];
  const csv = [headers.join(','), ...r.rows.map(row => [row.name,row.father_name,row.mother_name,row.phone,row.class,row.section,row.total_fee,row.paid_fee,Math.max(0,row.total_fee-row.paid_fee),row.last_paid||''].map(v=>`"${v||''}"`).join(','))].join('\n');
  res.setHeader('Content-Type','text/csv'); res.setHeader('Content-Disposition','attachment; filename=students.csv'); res.send(csv);
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../frontend/build/index.html')));

initDB().then(() => { const PORT = process.env.PORT || 4000; app.listen(PORT, () => console.log(`Server on port ${PORT}`)); });
