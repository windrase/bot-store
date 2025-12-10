require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
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

// Mengatur status user (sedang deposit/broadcast/restore)
global.state = {}; 
global.pendingDeposits = {};
let lastRequestTime = 0;

// Init DB
initDB();

// Load Pending Transactions
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

// MENU UTAMA (LOGIKA ANTI-FREEZE)
const showMainMenu = async (ctx, isEdit = false) => {
    const userId = ctx.from.id;
    const username = ctx.from.username ? `@${ctx.from.username}` : 'Hidden';
    const fullName = ctx.from.first_name;

    // Reset state agar tidak nyangkut di mode broadcast/restore
    delete global.state[userId];

    // Simpan data user
    db.run('INSERT OR IGNORE INTO users (user_id, username, full_name, joined_at) VALUES (?, ?, ?, ?)', 
        [userId, username, fullName, Date.now()]);

    // Ambil saldo terbaru
    db.get('SELECT saldo FROM users WHERE user_id = ?', [userId], async (err, row) => {
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
            [Markup.button.callback('🛒 Beli Produk', 'menu_produk'), Markup.button.callback('📦 Cek Stok', 'user_check_stock')],
            [Markup.button.callback('💳 Isi Saldo (QRIS)', 'topup_saldo')],
            [Markup.button.url('📞 Bantuan Admin', 'https://t.me/WINTUNELINGVPNN')]
        ];

        if (userId === ADMIN_ID) buttons.push([Markup.button.callback('🔒 Panel Admin', 'admin_panel')]);

        const keyboard = Markup.inlineKeyboard(buttons);

        try {
            if (isEdit) {
                // Coba edit, jika error (misal tipe pesan beda), hapus & kirim baru
                await ctx.editMessageText(message, { parse_mode: 'HTML', reply_markup: keyboard.reply_markup }).catch(async () => {
                    await ctx.deleteMessage().catch(()=>{});
                    await ctx.replyWithHTML(message, keyboard);
                });
            } else {
                await ctx.replyWithHTML(message, keyboard);
            }
        } catch (e) {
            console.log("Menu Error:", e.message);
        }
    });
};

// Handle Command /start dan /menu
bot.command(['start', 'menu'], (ctx) => showMainMenu(ctx, false));

// Handle Tombol Back (Menggunakan logika smart agar tidak freeze)
bot.action(['back_home', 'start'], async (ctx) => {
    await ctx.answerCbQuery();
    showMainMenu(ctx, true);
});

// 2. FITUR USER: CEK STOK & BELI
bot.action('user_check_stock', (ctx) => {
    const query = `
        SELECT p.name, COUNT(s.id) as count 
        FROM products p 
        LEFT JOIN stocks s ON p.code = s.product_code AND s.status = 'available'
        GROUP BY p.code
    `;
    db.all(query, [], (err, rows) => {
        let msg = '📦 <b>INFO STOK TERSEDIA</b>\n\n';
        if (!rows || rows.length === 0) msg += "<i>Belum ada produk.</i>";
        else rows.forEach(r => { msg += `🔹 <b>${r.name}</b>: ${r.count} pcs\n`; });
        
        ctx.editMessageText(msg, {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: [[Markup.button.callback('🔙 Kembali', 'back_home')]] }
        }).catch(() => showMainMenu(ctx, false));
    });
});

bot.action('menu_produk', (ctx) => {
    db.all('SELECT * FROM products', [], (err, rows) => {
        const btns = rows.map(p => [Markup.button.callback(`${p.name} - ${formatRp(p.price)}`, `view_${p.code}`)]);
        btns.push([Markup.button.callback('🔙 Kembali', 'back_home')]);
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

                // Proses Transaksi
                db.run('UPDATE users SET saldo = saldo - ? WHERE user_id=?', [p.price, userId]);
                db.run('UPDATE stocks SET status="sold", sold_to=?, date_sold=? WHERE id=?', [userId, Date.now(), stock.id]);

                const accountData = formatAccountData(stock.data_account);
                const msgUser = 
                    `✅ <b>TRANSAKSI BERHASIL!</b>\n\n` +
                    `📦 Produk: ${p.name}\n` +
                    `💸 Harga: ${formatRp(p.price)}\n\n` +
                    `👇 <b>DATA AKUN ANDA:</b>\n` +
                    `${accountData}\n\n` +
                    `<i>Harap simpan data ini. Terima kasih!</i>`;
                
                ctx.editMessageText(msgUser, {parse_mode:'HTML'});

                // Notif ke Channel (Estetik)
                if (CHANNEL_ID) {
                    bot.telegram.sendMessage(CHANNEL_ID, 
                        `🛍️ <b>NEW ORDER!</b>\n\n` +
                        `👤 <b>Buyer:</b> ${ctx.from.first_name}\n` +
                        `📦 <b>Item:</b> ${p.name}\n` +
                        `💰 <b>Price:</b> ${formatRp(p.price)}\n` +
                        `🕒 <b>Date:</b> ${new Date().toLocaleString('id-ID')}`,
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

// FITUR TOPUP & DEPOSIT
bot.action('topup_saldo', async (ctx) => {
    await ctx.answerCbQuery();
    global.state[ctx.from.id] = { mode: 'INPUT_DEPOSIT' };
    
    ctx.editMessageText('💰 <b>Isi Saldo Otomatis</b>\n\nKetik nominal (min 1000) atau pilih tombol:', {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [
            [Markup.button.callback('10.000', 'set_depo_10000'), Markup.button.callback('25.000', 'set_depo_25000')],
            [Markup.button.callback('50.000', 'set_depo_50000'), Markup.button.callback('🔙 Batal', 'back_home')]
        ]}
    });
});

bot.action(/set_depo_(\d+)/, async (ctx) => {
    await ctx.deleteMessage().catch(()=>{});
    processDeposit(ctx, ctx.match[1]);
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
            timeout: 10000
        });

        if (res.data.status !== 'success') throw new Error('API Gagal');
        
        const qrImg = await axios.get(res.data.result.imageqris.url, { responseType: 'arraybuffer' });
        
        const msg = await ctx.replyWithPhoto({ source: Buffer.from(qrImg.data) }, {
            caption: `📝 <b>INVOICE DEPOSIT</b>\n\n💰 Total: <b>${formatRp(finalAmount)}</b>\n⚠️ <i>Transfer HARUS PERSIS nominal diatas (termasuk 3 digit terakhir)!</i>\n⏳ Expired: 5 Menit`,
            parse_mode: 'HTML'
        });

        global.pendingDeposits[uniqueCode] = {
            amount: finalAmount, userId, timestamp: now, status: 'pending', qrMessageId: msg.message_id
        };
        
        db.run(`INSERT INTO pending_deposits (unique_code, user_id, amount, status, timestamp, qr_message_id) VALUES (?,?,?,?,?,?)`, 
            [uniqueCode, userId, finalAmount, 'pending', now, msg.message_id]);
        
        delete global.state[userId];

    } catch (e) {
        console.error(e);
        ctx.reply('❌ Gagal membuat QRIS. Coba lagi nanti.');
    }
}

// ENGINE MUTASI & NOTIFIKASI
async function checkMutation() {
    if (Object.keys(global.pendingDeposits).length === 0) return;

    try {
        // Hapus Invoice Expired
        for (const [code, data] of Object.entries(global.pendingDeposits)) {
            if (Date.now() - data.timestamp > 5 * 60 * 1000) {
                bot.telegram.deleteMessage(data.userId, data.qrMessageId).catch(()=>{});
                bot.telegram.sendMessage(data.userId, '❌ Invoice Kedaluwarsa. Silakan request ulang.');
                delete global.pendingDeposits[code];
                db.run('DELETE FROM pending_deposits WHERE unique_code = ?', [code]);
            }
        }

        // Cek API
        const res = await axios.post(API_URL, buildPayload(), { headers, timeout: 5000 });
        const text = res.data;
        const blocks = typeof text === 'string' ? text.split('------------------------') : [];
        const incoming = [];
        blocks.forEach(b => {
            const m = b.match(/Kredit\s*:\s*(?:Rp\s*)?([\d.]+)/i);
            if (m) incoming.push(parseInt(m[1].replace(/\./g, '')));
        });

        // Match Logic
        for (const [code, data] of Object.entries(global.pendingDeposits)) {
            if (incoming.includes(data.amount)) {
                db.run('UPDATE users SET saldo = saldo + ? WHERE user_id = ?', [data.amount, data.userId]);
                
                // Notif User (Menarik)
                bot.telegram.sendMessage(data.userId, 
                    `✅ <b>DEPOSIT BERHASIL!</b>\n\n` +
                    `💰 Nominal: ${formatRp(data.amount)}\n` +
                    `📅 Waktu: ${new Date().toLocaleString('id-ID')}\n\n` +
                    `<i>Saldo telah ditambahkan ke akun Anda.</i>`, 
                    {parse_mode:'HTML'}
                );
                bot.telegram.deleteMessage(data.userId, data.qrMessageId).catch(()=>{});
                
                // Notif Channel (Blockquote)
                if (CHANNEL_ID) {
                    const quoteMsg = 
`<blockquote>
🔔 <b>DEPOSIT RECEIVED</b>
👤 <b>User ID:</b> ${data.userId}
💰 <b>Amount:</b> ${formatRp(data.amount)}
📅 <b>Date:</b> ${new Date().toLocaleString('id-ID')}
</blockquote>`;
                    bot.telegram.sendMessage(CHANNEL_ID, quoteMsg, { parse_mode: 'HTML' });
                }

                delete global.pendingDeposits[code];
                db.run('DELETE FROM pending_deposits WHERE unique_code = ?', [code]);
            }
        }
    } catch (e) { }
}

// Loop Cek Mutasi yang Aman
const startMutationLoop = async () => {
    await checkMutation();
    setTimeout(startMutationLoop, 10000);
};
startMutationLoop();

// HANDLER TEXT & DOCUMENT (ADMIN LOGIC)
bot.on(['text', 'photo', 'document'], async (ctx) => {
    const userId = ctx.from.id;
    const userState = global.state[userId];

    // 1. Handle Input Deposit User
    if (userState?.mode === 'INPUT_DEPOSIT' && ctx.message.text) {
        const amount = parseInt(ctx.message.text.replace(/[^0-9]/g, ''));
        if (isNaN(amount) || amount < 1000) return ctx.reply('⚠️ Minimal deposit Rp 1.000');
        return processDeposit(ctx, amount);
    }

    // 2. Logic Admin
    if (userId !== ADMIN_ID) return;

    // Command Add Saldo Manual: /addsaldo 12345 50000
    if (ctx.message.text && ctx.message.text.startsWith('/addsaldo')) {
        const args = ctx.message.text.split(' ');
        const targetId = args[1];
        const amount = parseInt(args[2]);

        if (!targetId || !amount) return ctx.reply('❌ Format: /addsaldo <ID_USER> <JUMLAH>');

        db.run('UPDATE users SET saldo = saldo + ? WHERE user_id = ?', [amount, targetId], function(err) {
            if (this.changes > 0) {
                ctx.reply(`✅ Berhasil tambah ${formatRp(amount)} ke ID ${targetId}`);
                bot.telegram.sendMessage(targetId, `💰 <b>BONUS SALDO DARI ADMIN</b>\nJumlah: ${formatRp(amount)}`, {parse_mode:'HTML'}).catch(()=>{});
            } else {
                ctx.reply('❌ User ID tidak ditemukan di database.');
            }
        });
        return;
    }

    // Command Add Stok: /addstok netflix_1b data
    if (ctx.message.text && ctx.message.text.startsWith('/addstok')) {
        const args = ctx.message.text.split(' ');
        const code = args[1];
        const data = args.slice(2).join(' ');

        if (!code || !data) return ctx.reply('❌ Format: /addstok <kode> <data>');

        db.run('INSERT INTO stocks (product_code, data_account) VALUES (?, ?)', [code, data], (err) => {
            if (err) return ctx.reply('❌ Gagal simpan ke database.');
            ctx.reply(`✅ Stok ${code} berhasil ditambah.`);
        });
        return;
    }

    // Handle Broadcast (Foto/Teks)
    if (userState?.mode === 'BROADCAST') {
        if (ctx.message.text === '/batal') {
            delete global.state[userId];
            return ctx.reply('❌ Broadcast dibatalkan.');
        }

        ctx.reply('⏳ Mengirim broadcast ke seluruh user...');
        delete global.state[userId];

        db.all('SELECT user_id FROM users', [], async (err, rows) => {
            let success = 0;
            for (const row of rows) {
                try {
                    if (ctx.message.photo) {
                        // Broadcast Foto
                        const photoId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
                        const caption = ctx.message.caption ? `📢 <b>INFO ADMIN</b>\n\n${ctx.message.caption}` : '';
                        await bot.telegram.sendPhoto(row.user_id, photoId, { caption: caption, parse_mode: 'HTML' });
                    } else {
                        // Broadcast Teks
                        await bot.telegram.sendMessage(row.user_id, `📢 <b>INFO ADMIN</b>\n\n${ctx.message.text}`, {parse_mode:'HTML'});
                    }
                    success++;
                    await new Promise(r => setTimeout(r, 200)); 
                } catch (e) {}
            }
            ctx.reply(`✅ Broadcast selesai. Terkirim ke ${success} user.`);
        });
        return;
    }

    // Handle Restore Database
    if (userState?.mode === 'RESTORE' && ctx.message.document) {
        const doc = ctx.message.document;
        if (!doc.file_name.endsWith('.sqlite')) return ctx.reply('❌ File harus berformat .sqlite');

        try {
            const fileLink = await ctx.telegram.getFileLink(doc.file_id);
            const writer = fs.createWriteStream('./database.sqlite');
            const response = await axios({ url: fileLink.href, method: 'GET', responseType: 'stream' });
            
            response.data.pipe(writer);

            writer.on('finish', () => {
                delete global.state[userId];
                ctx.reply('✅ Database berhasil di-restore! Silakan restart bot jika perlu.');
                initDB(); // Reload koneksi DB
            });
            writer.on('error', () => ctx.reply('❌ Gagal menulis file.'));
        } catch (e) {
            ctx.reply('❌ Gagal download file.');
        }
    }
});

// PANEL ADMIN (UPDATE)
bot.action('admin_panel', (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    ctx.editMessageText('🔒 <b>Admin Panel v7.5</b>', {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [
            [Markup.button.callback('📦 Cek Sisa Stok', 'check_stock')],
            [Markup.button.callback('📡 Broadcast (Foto/Teks)', 'start_broadcast')],
            [Markup.button.callback('📤 Backup Manual', 'force_backup'), Markup.button.callback('📥 Restore DB', 'start_restore')],
            [Markup.button.callback('🔙 Kembali', 'back_home')]
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
        msg += '\n<i>Gunakan /addstok (kode) (data) untuk menambah.</i>';
        ctx.editMessageText(msg, {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: [[Markup.button.callback('🔙 Kembali', 'admin_panel')]] }
        });
    });
});

bot.action('start_broadcast', (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    global.state[ADMIN_ID] = { mode: 'BROADCAST' };
    ctx.reply('📡 <b>Mode Broadcast Aktif</b>\nSilakan kirim <b>Pesan Teks</b> atau <b>Foto + Caption</b> sekarang.\n\nKetik /batal untuk cancel.', {parse_mode:'HTML'});
});

bot.action('start_restore', (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    global.state[ADMIN_ID] = { mode: 'RESTORE' };
    ctx.reply('📥 <b>Mode Restore Database</b>\nSilakan kirim file <code>.sqlite</code> backup Anda kesini sekarang.', {parse_mode:'HTML'});
});

bot.action('force_backup', (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    ctx.reply('⏳ Memproses backup manual...');
    runAutoBackup();
});

// AUTO BACKUP (JAM 00:00)
const startBackupLoop = () => {
    const now = new Date();
    if (now.getHours() === 0 && now.getMinutes() === 0) {
        runAutoBackup();
    }
    setTimeout(startBackupLoop, 60000);
};
startBackupLoop();

function runAutoBackup() {
    console.log('🔄 Menjalankan Auto Backup...');
    const backupName = `backup_db_${new Date().toISOString().split('T')[0]}.sqlite`;
    
    fs.copyFile('./database.sqlite', backupName, async (err) => {
        if (err) return console.error('❌ Backup Gagal:', err);
        try {
            await bot.telegram.sendDocument(ADMIN_ID, { source: backupName, filename: backupName }, {
                caption: `📦 <b>AUTO BACKUP</b>\n📅 ${new Date().toLocaleString()}\n🛡️ <i>Simpan file ini untuk restore.</i>`,
                parse_mode: 'HTML'
            });
            console.log('✅ Backup terkirim.');
            fs.unlinkSync(backupName);
        } catch (e) {
            console.error('❌ Gagal kirim backup:', e);
        }
    });
}

// Start
bot.launch().then(() => console.log('🚀 BOT PLATINUM V7.5 READY!'));
process.once('SIGINT', () => bot.stop('SIGINT'));
