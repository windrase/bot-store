const fs = require('fs');
const readline = require('readline');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

console.log('\n╔════════════════════════════════════════════╗');
console.log('║         🤖 WINTUNELING STORE BOT              ║');
console.log('╚════════════════════════════════════════════╝\n');

const questions = [
  { key: 'BOT_TOKEN', msg: '1. Masukkan Token Bot (dari @BotFather): ' },
  { key: 'ADMIN_ID', msg: '2. Masukkan ID Telegram Admin (Angka): ' },
  { key: 'DATA_QRIS', msg: '3. Masukkan String/URL QRIS: ' },
  { key: 'CHANNEL_ID', msg: '4. Masukkan ID Channel/Grup Notifikasi (contoh -100xxx): ' }
];

let config = {};

const ask = (i) => {
  if (i === questions.length) {
    save();
    return;
  }
  rl.question(`👉 ${questions[i].msg}`, (ans) => {
    if (!ans) { console.log('❌ Tidak boleh kosong!'); return ask(i); }
    config[questions[i].key] = ans.trim();
    ask(i + 1);
  });
};

const save = () => {
  const content = Object.entries(config).map(([k, v]) => `${k}="${v}"`).join('\n');
  fs.writeFileSync('.env', content);
  
  console.log('\n✅ KONFIGURASI TERSIMPAN!');
  console.log('🔄 Menyiapkan database & produk...');
  
  const { initDB, seedProducts } = require('./database');
  initDB();
  setTimeout(() => {
      seedProducts();
      console.log('\n✅ INSTALASI SELESAI!');
      console.log('🚀 Jalankan bot dengan perintah: npm start');
      process.exit(0);
  }, 1000);
};

ask(0);
