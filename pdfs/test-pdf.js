const fs = require('fs');
fs.writeFileSync('pdfs/test.pdf', 'Ovo je testna vest za JESV.', 'utf8');
console.log('Test PDF kreiran.');