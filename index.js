require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const fs = require('fs');
const { db, initDB } = require('./database');
const { buildPayload, headers, API_URL } = require('./api-cekpayment-orkut');

// --- CEK CONFIG ---
if (!process.env.BOT_TOKEN) {
    console.error('❌ ERROR: Jalankan "npm run setup" terlebih dahulu!');
    process.exit(1);
}

const bot = new Telegraf(process.env.BOT_TOKEN);
const ADMIN_ID = parseInt(process.env.ADMIN_ID);
const CHANNEL_ID = process.env.CHANNEL_ID;
const QRIS_DATA = process.env.DATA_QRIS;

// --- GLOBAL STATE ---
global.depositState = {};
global.pendingDeposits = {};
let lastRequestTime = 0;

// Init DB
initDB();

// Load Pending Transactions saat restart
db.all('SELECT * FROM pending_deposits WHERE status = "pending"', [], (err, rows) => {
    if (rows) {
        rows.forEach(r => global.pendingDeposits[r.unique_code] = {
            amount: r.amount, userId: r.user_id, timestamp: r.timestamp,
            status: r.status, qrMessageId: r.qr_message_id
        });
        console.log(`🔄 Loaded ${rows.length} pending deposits.`);
    }
});

const formatRp = (n) => 'Rp ' + parseInt(n).toLocaleString('id-ID');
const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

// ==========================================
// 1. MENU UTAMA (USER PROFILE)
// ==========================================
bot.start((ctx) => {
    const userId = ctx.from.id;
    const username = ctx.from.username ? `@${ctx.from.username}` : '-';
    const fullName = ctx.from.first_name;

    db.run('INSERT OR IGNORE INTO users (user_id, username, full_name, joined_at) VALUES (?, ?, ?, ?)', 
        [userId, username, fullName, Date.now()]);

    db.get('SELECT saldo FROM users WHERE user_id = ?', [userId], (err, row) => {
        const saldo = row ? row.saldo : 0;
        
        const message = `╔════════════════════╗
   <b>⚡ WINTUNELING STORE ⚡</b>    
╚════════════════════╝

╭─── 👤 <b>USER PROFILE</b>
│ 📛 <b>Nama :</b> ${fullName}
│ 🆔 <b>ID :</b> <code>${userId}</code>
│ 💎 <b>User :</b> ${username}
│ 💵 <b>Saldo:</b> <code>${formatRp(saldo)}</code>
╰─────────────────

👇 <b>Pilih Menu Transaksi:</b>`;

        const buttons = [
            [Markup.button.callback('🛒 Beli Produk Digital', 'menu_produk')],
            [Markup.button.callback('💳 Isi Saldo (QRIS)', 'topup_saldo')],
            [Markup.button.callback('📞 Bantuan Admin', 'help')]
        ];

        if (userId === ADMIN_ID) buttons.push([Markup.button.callback('🔒 Panel Admin', 'admin_panel')]);

        ctx.replyWithHTML(message, Markup.inlineKeyboard(buttons));
    });
});

bot.action('start', (ctx) => ctx.scene ? ctx.scene.leave() : bot.handleUpdate(ctx.update));

// ==========================================
// 2. FITUR TOPUP (QRIS + KODE UNIK)
// ==========================================
bot.action('topup_saldo', async (ctx) => {
    await ctx.answerCbQuery();
    global.depositState[ctx.from.id] = { action: 'request_amount' };
    
    ctx.reply('💰 <b>Isi Saldo Otomatis</b>\n\nKetik nominal (min 1000) atau pilih tombol:', {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [
            [Markup.button.callback('10.000', 'set_depo_10000'), Markup.button.callback('25.000', 'set_depo_25000')],
            [Markup.button.callback('50.000', 'set_depo_50000'), Markup.button.callback('❌ Batal', 'start')]
        ]}
    });
});

bot.action(/set_depo_(\d+)/, async (ctx) => {
    await ctx.deleteMessage();
    processDeposit(ctx, ctx.match[1]);
});

bot.on('text', async (ctx) => {
    const userId = ctx.from.id;
    if (global.depositState[userId]?.action === 'request_amount') {
        const amount = parseInt(ctx.message.text.replace(/[^0-9]/g, ''));
        if (isNaN(amount) || amount < 1000) return ctx.reply('⚠️ Nominal tidak valid, minimal 1000.');
        processDeposit(ctx, amount);
        return;
    }
    if (global.depositState[userId]?.action === 'broadcast_msg' && userId === ADMIN_ID) {
        executeBroadcast(ctx, ctx.message.text);
    }
});

async function processDeposit(ctx, amount) {
    const userId = ctx.from.id;
    const now = Date.now();
    if (now - lastRequestTime < 2000) return ctx.reply('⏳ Tunggu sebentar...');
    lastRequestTime = now;

    const finalAmount = Number(amount) + rand(1, 150);
    const uniqueCode = `depo-${userId}-${now}`;

    try {
        const res = await axios.get(`https://api.rajaserverpremium.web.id/orderkuota/createpayment`, {
            params: { apikey: 'AriApiPaymetGetwayMod', amount: finalAmount, codeqr: QRIS_DATA },
            timeout: 10000 // Timeout agar tidak hang
        });

        if (res.data.status !== 'success') throw new Error('API Gagal');
        
        const qrImg = await axios.get(res.data.result.imageqris.url, { responseType: 'arraybuffer', timeout: 10000 });
        
        const msg = await ctx.replyWithPhoto({ source: Buffer.from(qrImg.data) }, {
            caption: `📝 <b>INVOICE DEPOSIT</b>\n\n💰 Total Transfer: <b>${formatRp(finalAmount)}</b>\n⚠️ <i>Transfer HARUS PERSIS 3 digit terakhir!</i>\n⏳ Expired: 5 Menit`,
            parse_mode: 'HTML'
        });

        global.pendingDeposits[uniqueCode] = {
            amount: finalAmount, userId, timestamp: now, status: 'pending', qrMessageId: msg.message_id
        };
        
        db.run(`INSERT INTO pending_deposits (unique_code, user_id, amount, status, timestamp, qr_message_id) VALUES (?,?,?,?,?,?)`, 
            [uniqueCode, userId, finalAmount, 'pending', now, msg.message_id]);
        
        delete global.depositState[userId];

    } catch (e) {
        console.error("Error creating QRIS:", e.message);
        ctx.reply('❌ Gagal membuat QRIS. Silakan coba lagi nanti.');
    }
}

// ==========================================
// 3. ENGINE MUTASI & NOTIFIKASI (FIXED MEMORY LEAK)
// ==========================================
async function checkMutation() {
    // Jika tidak ada transaksi pending, skip request ke API untuk hemat resource
    if (Object.keys(global.pendingDeposits).length === 0) return;

    try {
        // Hapus Invoice Expired (Lebih dari 5 menit)
        for (const [code, data] of Object.entries(global.pendingDeposits)) {
            if (Date.now() - data.timestamp > 5 * 60 * 1000) {
                // Jangan await deleteMessage agar tidak blocking
                bot.telegram.deleteMessage(data.userId, data.qrMessageId).catch(()=>{});
                bot.telegram.sendMessage(data.userId, '❌ Invoice Kedaluwarsa.');
                delete global.pendingDeposits[code];
                db.run('DELETE FROM pending_deposits WHERE unique_code = ?', [code]);
            }
        }

        // Cek API dengan Garbage Collection Manual pada Axios
        const res = await axios.post(API_URL, buildPayload(), { 
            headers, 
            timeout: 8000, // Timeout dipercepat
            maxContentLength: 5000000 // Batas ukuran response 5MB mencegah OOM
        });
        
        const text = res.data;
        const blocks = typeof text === 'string' ? text.split('------------------------') : [];
        const incoming = [];
        
        // Parsing response
        blocks.forEach(b => {
            const m = b.match(/Kredit\s*:\s*(?:Rp\s*)?([\d.]+)/i);
            if (m) incoming.push(parseInt(m[1].replace(/\./g, '')));
        });

        // Match Logic
        for (const [code, data] of Object.entries(global.pendingDeposits)) {
            if (incoming.includes(data.amount)) {
                db.run('UPDATE users SET saldo = saldo + ? WHERE user_id = ?', [data.amount, data.userId]);
                
                bot.telegram.sendMessage(data.userId, `✅ <b>DEPOSIT SUKSES!</b>\nSaldo +${formatRp(data.amount)}`, {parse_mode:'HTML'});
                bot.telegram.deleteMessage(data.userId, data.qrMessageId).catch(()=>{});
                
                if (CHANNEL_ID) {
                    bot.telegram.sendMessage(CHANNEL_ID, 
                        `🔔 <b>DEPOSIT MASUK</b>\n\n👤 ID: ${data.userId}\n💰 Jumlah: ${formatRp(data.amount)}\n📅 Tgl: ${new Date().toLocaleString()}`,
                        { parse_mode: 'HTML' }
                    );
                }

                delete global.pendingDeposits[code];
                db.run('DELETE FROM pending_deposits WHERE unique_code = ?', [code]);
            }
        }
    } catch (e) { 
        // Error handling silent agar log tidak penuh
        // console.error("Mutation Error:", e.message); 
    }
}

// LOGIKA LOOPING YANG AMAN (PENGGANTI setInterval)
async function startMutationLoop() {
    await checkMutation();
    // Tunggu 10 detik SETELAH proses selesai baru jalan lagi
    setTimeout(startMutationLoop, 10000); 
}
startMutationLoop();

// ==========================================
// 4. FITUR AUTO BACKUP (JAM 00:00)
// ==========================================
function startBackupLoop() {
    const now = new Date();
    if (now.getHours() === 0 && now.getMinutes() === 0) {
        runAutoBackup();
    }
    // Cek lagi dalam 60 detik
    setTimeout(startBackupLoop, 60000); 
}
startBackupLoop();

function runAutoBackup() {
    console.log('🔄 Menjalankan Auto Backup...');
    const backupName = `backup_db_${new Date().toISOString().split('T')[0]}.sqlite`;
    
    // Copy file database untuk dikirim
    fs.copyFile('./database.sqlite', backupName, async (err) => {
        if (err) return console.error('❌ Backup Gagal:', err);
        
        try {
            await bot.telegram.sendDocument(ADMIN_ID, {
                source: backupName,
                filename: backupName
            }, {
                caption: `📦 <b>AUTO BACKUP DATABASE</b>\n📅 Tanggal: ${new Date().toLocaleString()}\n🛡️ <i>File ini aman, hanya admin yang menerima.</i>`,
                parse_mode: 'HTML'
            });
            console.log('✅ Backup terkirim ke Admin.');
            fs.unlinkSync(backupName);
        } catch (e) {
            console.error('❌ Gagal kirim backup ke Telegram:', e);
        }
    });
}

// ==========================================
// 5. MENU PRODUK & KIRIM AKUN
// ==========================================
bot.action('menu_produk', (ctx) => {
    db.all('SELECT * FROM products', [], (err, rows) => {
        const btns = rows.map(p => [Markup.button.callback(`${p.name} - ${formatRp(p.price)}`, `view_${p.code}`)]);
        btns.push([Markup.button.callback('🔙 Kembali', 'start')]);
        ctx.editMessageText('🛒 <b>Pilih Produk Digital:</b>', { parse_mode: 'HTML', reply_markup: { inline_keyboard: btns }});
    });
});

bot.action(/view_(.+)/, (ctx) => {
    const code = ctx.match[1];
    db.get('SELECT * FROM products WHERE code = ?', [code], (err, p) => {
        if (!p) return;
        db.get('SELECT COUNT(*) as c FROM stocks WHERE product_code = ? AND status = "available"', [code], (err, s) => {
            const stok = s ? s.c : 0;
            const btn = stok > 0 ? [Markup.button.callback('🛒 BELI SEKARANG', `buy_${code}`)] : [];
            ctx.editMessageText(
                `📦 <b>${p.name}</b>\n\n📝 ${p.description}\n💰 Harga: <b>${formatRp(p.price)}</b>\n📊 Stok: ${stok}`,
                { parse_mode: 'HTML', reply_markup: { inline_keyboard: [btn, [Markup.button.callback('🔙 Kembali', 'menu_produk')]]}}
            );
        });
    });
});

bot.action(/buy_(.+)/, (ctx) => {
    const code = ctx.match[1];
    const userId = ctx.from.id;

    db.get('SELECT * FROM products WHERE code =?', [code], (err, p) => {
        db.get('SELECT saldo FROM users WHERE user_id=?', [userId], (err, u) => {
            if (u.saldo < p.price) return ctx.answerCbQuery('❌ Saldo Kurang!', {show_alert:true});
            
            db.get('SELECT * FROM stocks WHERE product_code=? AND status="available" LIMIT 1', [code], (err, stock) => {
                if (!stock) return ctx.answerCbQuery('❌ Stok Habis!', {show_alert:true});

                db.run('UPDATE users SET saldo = saldo - ? WHERE user_id=?', [p.price, userId]);
                db.run('UPDATE stocks SET status="sold", sold_to=?, date_sold=? WHERE id=?', [userId, Date.now(), stock.id]);

                const accountData = formatAccountData(stock.data_account);
                const msgUser = 
                    `✅ <b>TRANSAKSI BERHASIL!</b>\n\n` +
                    `📦 Produk: ${p.name}\n` +
                    `💸 Harga: ${formatRp(p.price)}\n\n` +
                    `👇 <b>DATA AKUN ANDA:</b>\n` +
                    `${accountData}\n\n` +
                    `<i>Simpan data ini. Terima kasih!</i>`;
                
                ctx.editMessageText(msgUser, {parse_mode:'HTML'});

                if (CHANNEL_ID) {
                    bot.telegram.sendMessage(CHANNEL_ID, 
                        `🛍️ <b>PENJUALAN BARU!</b>\n\n📦 Item: ${p.name}\n👤 Pembeli: ${ctx.from.first_name} (ID: ${userId})\n💰 Harga: ${formatRp(p.price)}\n🕒 Waktu: ${new Date().toLocaleString()}`,
                        { parse_mode: 'HTML' }
                    );
                }
            });
        });
    });
});

function formatAccountData(rawData) {
    if (rawData.includes('|')) {
        const [email, pass, profile, pin] = rawData.split('|');
        return `📧 <b>Email:</b> <code>${email}</code>\n` +
               `🔑 <b>Pass:</b> <code>${pass}</code>\n` +
               `👤 <b>Profil:</b> ${profile || '-'}\n` +
               `🔒 <b>PIN:</b> ${pin || '-'}`;
    }
    return `🔐 <b>Akses:</b>\n<code>${rawData}</code>`;
}

// ==========================================
// 6. PANEL ADMIN (BROADCAST & STOK)
// ==========================================
bot.action('admin_panel', (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    ctx.editMessageText('🔒 <b>Admin Panel</b>', {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [
            [Markup.button.callback('📦 Cek Sisa Stok', 'check_stock')],
            [Markup.button.callback('📡 Broadcast Pesan', 'start_broadcast')],
            [Markup.button.callback('📥 Backup Manual', 'force_backup')],
            [Markup.button.callback('🔙 Kembali', 'start')]
        ]}
    });
});

bot.action('check_stock', (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    const query = `
        SELECT p.name, p.code, COUNT(s.id) as count 
        FROM products p 
        LEFT JOIN stocks s ON p.code = s.product_code AND s.status = 'available'
        GROUP BY p.code
    `;
    db.all(query, [], (err, rows) => {
        let msg = '📊 <b>LAPORAN SISA STOK</b>\n\n';
        rows.forEach(r => { msg += `▫️ <b>${r.name}</b>: ${r.count} pcs\n`; });
        msg += '\n<i>Gunakan /addstok untuk menambah.</i>';
        ctx.editMessageText(msg, {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: [[Markup.button.callback('🔙 Kembali', 'admin_panel')]] }
        });
    });
});

bot.action('force_backup', (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    ctx.reply('⏳ Memproses backup manual...');
    runAutoBackup();
});

bot.action('start_broadcast', (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    global.depositState[ADMIN_ID] = { action: 'broadcast_msg' };
    ctx.reply('✍️ <b>Ketik Pesan Broadcast:</b>\n(Ketik /batal untuk cancel)', {parse_mode:'HTML'});
});

async function executeBroadcast(ctx, message) {
    if (message === '/batal') {
        delete global.depositState[ADMIN_ID];
        return ctx.reply('❌ Broadcast dibatalkan.');
    }
    ctx.reply('⏳ Mengirim broadcast...');
    delete global.depositState[ADMIN_ID];

    db.all('SELECT user_id FROM users', [], async (err, rows) => {
        let success = 0;
        for (const row of rows) {
            try {
                await bot.telegram.sendMessage(row.user_id, `📢 <b>INFO ADMIN</b>\n\n${message}`, {parse_mode:'HTML'});
                success++;
                await new Promise(r => setTimeout(r, 200)); 
            } catch (e) {}
        }
        ctx.reply(`✅ Broadcast selesai. Terkirim ke ${success} user.`);
    });
}

bot.command('addstok', (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    const args = ctx.message.text.split(' ');
    const code = args[1];
    const data = args.slice(2).join(' ');

    if (!code || !data) return ctx.reply('❌ Format: /addstok <kode> <data>');

    db.run('INSERT INTO stocks (product_code, data_account) VALUES (?, ?)', [code, data], (err) => {
        if (err) return ctx.reply('❌ Gagal.');
        ctx.reply(`✅ Stok ${code} berhasil ditambah.`);
    });
});

// START
bot.launch().then(() => console.log('🚀 BOT PLATINUM V7 READY (SAFE MODE)!'));
process.once('SIGINT', () => bot.stop('SIGINT'));
