// Builds restaurant-billing-offline.html: the same app with jsPDF and SheetJS inlined (works with no internet).
const fs = require('fs'), path = require('path');
const root = __dirname, html = fs.readFileSync(path.join(root, 'restaurant-billing.html'), 'utf8');
const j = fs.readFileSync(path.join(root, 'vendor/jspdf.umd.min.js'), 'utf8').replace(/<\/script/gi, '<\\/script').replace(/\/\/# sourceMappingURL=.*$/m, '');
const x = fs.readFileSync(path.join(root, 'vendor/xlsx.full.min.js'), 'utf8').replace(/<\/script/gi, '<\\/script').replace(/\/\/# sourceMappingURL=.*$/m, '');
let n = 0;
const out = html.replace(/<script src="https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/jspdf\/[^"]+"[^>]*><\/script>/, () => { n++; return '<script>' + j + '</script>'; })
  .replace(/<script src="https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/xlsx\/[^"]+"[^>]*><\/script>/, () => { n++; return '<script>' + x + '</script>'; });
if (n !== 2) throw new Error('expected 2 CDN script tags, replaced ' + n);
fs.writeFileSync(path.join(root, 'restaurant-billing-offline.html'), out);
console.log('wrote restaurant-billing-offline.html', (out.length / 1048576).toFixed(2) + ' MB');
