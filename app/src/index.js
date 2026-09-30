const express = require('express');
const client = require('prom-client');

const app = express();
const PORT = process.env.PORT || 3000;

// 1. Metrics setup
// Default metrics: CPU, memory, event loop lag, etc. of the Node process
client.collectDefaultMetrics();

// Counts every request, labelled so we can later graph 5xx errors
const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
});

// Tracks how long requests take (used for latency graphs)
const httpDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
});

// 2. Middleware: runs for every request
app.use((req, res, next) => {
  const stopTimer = httpDuration.startTimer();

  // 'finish' fires once the response has been sent,
  // which is when we finally know the status code
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

// 3. Routes
app.get('/', (req, res) => {
  res.json({ message: 'Hello from the GitOps platform API' });
});

// Liveness: "is the process alive?" Kubernetes restarts the pod if this fails.
app.get('/healthz', (req, res) => {
  res.status(200).send('ok');
});

// Prometheus scrapes this endpoint
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', client.register.contentType);
  res.send(await client.register.metrics());
});

// 4. Start
app.listen(PORT, () => {
  console.log(`API listening on port ${PORT}`);
});