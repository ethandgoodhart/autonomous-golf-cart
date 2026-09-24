const express = require('express');
const fs = require('fs');
const path = require('path');

function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match && !process.env[match[1].trim()]) {
      process.env[match[1].trim()] = match[2].trim();
    }
  }
}

loadEnv();

const app = express();
const PORT = 3000;
const DATA_FILE = path.join(__dirname, 'annotations.json');

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/config', (req, res) => {
  res.json({ mapboxToken: process.env.MAPBOX_TOKEN || '' });
});

app.get('/api/load', (req, res) => {
  if (!fs.existsSync(DATA_FILE)) {
    return res.json({ annotations: [] });
  }
  const data = fs.readFileSync(DATA_FILE, 'utf-8');
  res.json(JSON.parse(data));
});

app.post('/api/save', (req, res) => {
  const data = req.body;
  if (!data || !Array.isArray(data.annotations)) {
    return res.status(400).json({ error: 'Invalid data format. Expected { annotations: [...], eraserPoints?: [...] }' });
  }
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  res.json({ success: true, count: data.annotations.length });
});

app.listen(PORT, () => {
  console.log(`Lane annotator running at http://localhost:${PORT}`);
});
