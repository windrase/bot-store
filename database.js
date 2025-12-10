const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./database.sqlite');

const initDB = () => {
    db.serialize(() => {
        // Tabel User
        db.run(`CREATE TABLE IF NOT EXISTS users (
            user_id INTEGER PRIMARY KEY,
            username TEXT,
            full_name TEXT,
            saldo INTEGER DEFAULT 0,
            joined_at INTEGER
        )`);

        // Tabel Produk
        db.run(`CREATE TABLE IF NOT EXISTS products (
            code TEXT PRIMARY KEY,
            name TEXT,
            price INTEGER,
            description TEXT
        )`);

        // Tabel Stok
        db.run(`CREATE TABLE IF NOT EXISTS stocks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            product_code TEXT,
            data_account TEXT,
            status TEXT DEFAULT 'available',
            sold_to INTEGER,
            date_sold INTEGER
        )`);

        // Tabel Pending Deposit
        db.run(`CREATE TABLE IF NOT EXISTS pending_deposits (
            unique_code TEXT PRIMARY KEY,
            user_id INTEGER,
            amount INTEGER,
            status TEXT,
            timestamp INTEGER,
            qr_message_id INTEGER
        )`);
    });
};

const seedProducts = () => {
    // Daftar Produk
    const products = [
        { code: 'netflix_1b', name: 'Netflix Premium 1 Bulan', price: 25000, desc: '4K UHD, Sharing Profile, Garansi' },
        { code: 'yt_prem', name: 'YouTube Premium 1 Bulan', price: 9000, desc: 'Via Invite Email Family' },
        { code: 'capcut_pro', name: 'CapCut Pro 1 Tahun', price: 30000, desc: 'Login Email Sendiri / Suntik' },
        { code: 'gemini_adv', name: 'Gemini Advanced', price: 15000, desc: 'Akun Shared AI Premium' },
        { code: 'alight_mo', name: 'Alight Motion Pro', price: 10000, desc: 'Login Akun (No Watermark)' }
    ];

    const stmt = db.prepare("INSERT OR REPLACE INTO products (code, name, price, description) VALUES (?, ?, ?, ?)");
    products.forEach(p => stmt.run(p.code, p.name, p.price, p.desc));
    stmt.finalize();
};

module.exports = { db, initDB, seedProducts };
