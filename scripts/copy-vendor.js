// Copies Leaflet (the free map library) into www/vendor so the app works offline-first.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = path.join(root, 'node_modules', 'leaflet', 'dist');
const dest = path.join(root, 'www', 'vendor', 'leaflet');

if (!fs.existsSync(src)) {
  console.warn('Leaflet not found. Run "npm install" first. Trip maps will fall back to a simple outline.');
  process.exit(0);
}

fs.mkdirSync(path.join(dest, 'images'), { recursive: true });
for (const f of ['leaflet.js', 'leaflet.css']) {
  fs.copyFileSync(path.join(src, f), path.join(dest, f));
}
for (const f of fs.readdirSync(path.join(src, 'images'))) {
  fs.copyFileSync(path.join(src, 'images', f), path.join(dest, 'images', f));
}
console.log('Copied Leaflet to www/vendor/leaflet');
