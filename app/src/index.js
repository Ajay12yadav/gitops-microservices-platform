const express = require('express');
const mysql = require('mysql2/promise');
const client = require('prom-client');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;

// ---------- Config: everything comes from environment variables ----------
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'appuser',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'appdb',
  waitForConnections: true,
  connectionLimit: 10,
  connectTimeout: 5000,
});

// ---------- Metrics ----------
client.collectDefaultMetrics();

const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
});

const httpDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
});

// ---------- App ----------
const app = express();
app.use(express.json());

let shuttingDown = false;

app.use((req, res, next) => {
  const stopTimer = httpDuration.startTimer();
  res.on('finish', () => {
    const labels = {
      method: req.method,
      route: req.route ? req.route.path : 'unmatched',
      status_code: res.statusCode,
    };
    httpRequestsTotal.inc(labels);
    stopTimer(labels);
  });
  next();
});

app.get('/', (req, res) => {
  res.json({ message: 'Hello from the GitOps platform API', pod: process.env.HOSTNAME });
});

// Liveness: is the process alive? Does NOT check the DB.
app.get('/healthz', (req, res) => res.status(200).send('ok'));

// Readiness: can this pod serve traffic? Checks the DB.
app.get('/readyz', async (req, res) => {
  if (shuttingDown) return res.status(503).send('shutting down');
  try {
    await pool.query('SELECT 1');
    res.status(200).send('ready');
  } catch (err) {
    res.status(503).send('database not reachable');
  }
});

app.get('/metrics', async (req, res) => {
  res.set('Content-Type', client.register.contentType);
  res.send(await client.register.metrics());
});

app.get('/items', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT id, name, created_at FROM items ORDER BY id DESC LIMIT 50');
    res.json(rows);
  } catch (err) {
    console.error('GET /items failed:', err.message);
    res.status(500).json({ error: 'database error' });
  }
});

app.post('/items', async (req, res) => {
  const { name } = req.body || {};
  if (typeof name !== 'string' || name.length === 0 || name.length > 255) {
    return res.status(400).json({ error: 'name (string, 1-255 chars) is required' });
  }
  try {
    const [result] = await pool.query('INSERT INTO items (name) VALUES (?)', [name]);
    res.status(201).json({ id: result.insertId, name });
  } catch (err) {
    console.error('POST /items failed:', err.message);
    res.status(500).json({ error: 'database error' });
  }
});

// CPU burner for the HPA demo: /cpu?ms=200 (capped at 2s)
app.get('/cpu', (req, res) => {
  const ms = Math.min(Number(req.query.ms) || 100, 2000);
  const end = Date.now() + ms;
  let hash = 'seed';
  while (Date.now() < end) {
    hash = crypto.createHash('sha256').update(hash).digest('hex');
  }
  res.json({ burnedMs: ms, pod: process.env.HOSTNAME });
});

// Deliberate 500 for testing the 5xx panel and alerts
app.get('/fail', (req, res) => res.status(500).json({ error: 'intentional failure' }));

// ---------- Database init (with retry) ----------
async function initDb() {
  for (let attempt = 1; ; attempt++) {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS items (
          id INT AUTO_INCREMENT PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);
      console.log('Database ready');
      return;
    } catch (err) {
      console.log(`DB not ready (attempt ${attempt}): ${err.message}`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

// ---------- Start + graceful shutdown ----------
const server = app.listen(PORT, () => {
  console.log(`API listening on port ${PORT}`);
  initDb();
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  shuttingDown = true;
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
});
