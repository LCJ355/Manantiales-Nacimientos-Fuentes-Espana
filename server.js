const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const IMAGES_DIR = path.join(__dirname, 'images');
const PHOTOS_JS = path.join(__dirname, 'photo_counts.js');

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, IMAGES_DIR),
  filename: (req, file, cb) => {
    const id = req.params.id;
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, `cf_${id}_temp_${uniqueSuffix}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Solo se permiten archivos de imagen'));
  }
});

function getPhotoCount(id) {
  const prefix = `cf_${id}_`;
  try {
    return fs.readdirSync(IMAGES_DIR)
      .filter(f => f.startsWith(prefix) && f.endsWith('.jpg') && !f.includes('_temp'))
      .map(f => parseInt(f.slice(prefix.length, -4)))
      .filter(n => !isNaN(n))
      .sort((a, b) => a - b);
  } catch { return []; }
}

function regeneratePhotoCounts() {
  const prefix = 'cf_';
  const counts = {};
  try {
    const files = fs.readdirSync(IMAGES_DIR).filter(f => f.startsWith(prefix) && f.endsWith('.jpg') && !f.includes('_temp'));
    for (const f of files) {
      const rest = f.slice(prefix.length, -4);
      const underscoreIdx = rest.lastIndexOf('_');
      if (underscoreIdx === -1) continue;
      const id = rest.slice(0, underscoreIdx);
      if (!counts[id]) counts[id] = 0;
      counts[id]++;
    }
  } catch { /* skip */ }
  const json = JSON.stringify(counts);
  fs.writeFileSync(PHOTOS_JS, `window.PHOTO_COUNTS = ${json};\n`, 'utf8');
  return counts;
}

function renumberPhotos(id) {
  const nums = getPhotoCount(id);
  if (nums.length === 0) return;
  let next = 1;
  for (const n of nums) {
    if (n !== next) {
      const oldPath = path.join(IMAGES_DIR, `cf_${id}_${n}.jpg`);
      const newPath = path.join(IMAGES_DIR, `cf_${id}_${next}.jpg`);
      if (fs.existsSync(oldPath)) fs.renameSync(oldPath, newPath);
    }
    next++;
  }
}

app.use(express.static(__dirname, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.js')) res.setHeader('Content-Type', 'application/javascript');
  }
}));

app.get('/api/photos/:id', (req, res) => {
  const nums = getPhotoCount(req.params.id);
  res.json({ id: req.params.id, count: nums.length, photos: nums });
});

app.post('/api/photos/:id', upload.array('photos', 10), (req, res) => {
  const id = req.params.id;
  const existing = getPhotoCount(id);
  let nextNum = existing.length > 0 ? Math.max(...existing) + 1 : 1;

  for (const file of (req.files || [])) {
    const finalPath = path.join(IMAGES_DIR, `cf_${id}_${nextNum}.jpg`);
    fs.renameSync(file.path, finalPath);
    nextNum++;
  }

  const counts = regeneratePhotoCounts();
  const newCount = getPhotoCount(id);
  res.json({ ok: true, id, count: newCount.length, photos: newCount, total: counts });
});

app.delete('/api/photos/:id/:n', (req, res) => {
  const id = req.params.id;
  const n = parseInt(req.params.n);
  if (isNaN(n) || n < 1) return res.status(400).json({ error: 'Número inválido' });

  const filePath = path.join(IMAGES_DIR, `cf_${id}_${n}.jpg`);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Foto no encontrada' });

  fs.unlinkSync(filePath);
  renumberPhotos(id);

  const counts = regeneratePhotoCounts();
  const newCount = getPhotoCount(id);
  res.json({ ok: true, id, count: newCount.length, photos: newCount, total: counts });
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (req.files) for (const f of req.files) if (fs.existsSync(f.path)) fs.unlinkSync(f.path);
    return res.status(400).json({ error: 'Error en upload: ' + err.message });
  }
  if (err) return res.status(500).json({ error: err.message });
  next();
});

app.listen(PORT, () => {
  console.log(`\n  💧 Fuentes de España - Server`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`  API fotos: /api/photos/:id\n`);
});
