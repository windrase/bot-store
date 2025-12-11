require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { db, initDB } = require('./database');
const { buildPayload, headers, API_URL } = require('./api-cekpayment-orkut');

// CEK CONFIG
if (!process.env.BOT_TOKEN) {
    console.error('❌ ERROR: Jalankan "npm run setup" terlebih dahulu!');
    process.exit(1);
}

const bot = new Telegraf(process.env.BOT_TOKEN);
const ADMIN_ID = parseInt(process.env.ADMIN_ID);
const CHANNEL_ID = process.env.CHANNEL_ID;
const QRIS_DATA = process.env.DATA_QRIS;

// GLOBAL STATE
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

// 1. MENU UTAMA
const showMainMenu = async (ctx, isEdit = false) => {
    const userId = ctx.from.id;
    const username = ctx.from.username ? `@${ctx.from.username}` : 'Hidden';
    const fullName = ctx.from.first_name;

    delete global.state[userId];

    db.run('INSERT OR IGNORE INTO users (user_id, username, full_name, joined_at) VALUES (?, ?, ?, ?)', 
        [userId, username, fullName, Date.now()]);

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
            [Markup.button.callback('📊 Cek Kuota XL', 'menu_cek_kuota')],
            [Markup.button.callback('💳 Isi Saldo (QRIS)', 'topup_saldo')],
            [Markup.button.url('📞 Bantuan Admin', 'https://t.me/WINTUNELINGVPNN')]
        ];

        if (userId === ADMIN_ID) buttons.push([Markup.button.callback('🔒 Panel Admin', 'admin_panel')]);

        const keyboard = Markup.inlineKeyboard(buttons);

        try {
            if (isEdit) {
                await ctx.editMessageText(message, { parse_mode: 'HTML', reply_markup: keyboard.reply_markup }).catch(async () => {
                    await ctx.deleteMessage().catch(()=>{});
                    await ctx.replyWithHTML(message, keyboard);
                });
            } else {
                await ctx.replyWithHTML(message, keyboard);
            }
        } catch (e) {}
    });
};

bot.command(['start', 'menu'], (ctx) => showMainMenu(ctx, false));
bot.action(['back_home', 'start'], async (ctx) => {
    await ctx.answerCbQuery();
    showMainMenu(ctx, true);
});

// FITUR CEK STOK & BELI
const getStockReport = (cb) => {
    const query = `
        SELECT p.name, p.code, COUNT(s.id) as count 
        FROM products p 
        LEFT JOIN stocks s ON p.code = s.product_code AND s.status = 'available'
        GROUP BY p.code
    `;
    db.all(query, [], (err, rows) => cb(rows));
};

bot.action('user_check_stock', (ctx) => {
    getStockReport((rows) => {
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
        if (!rows || rows.length === 0) {
            return ctx.editMessageText('❌ Belum ada produk yang dijual.', {
                reply_markup: { inline_keyboard: [[Markup.button.callback('🔙 Kembali', 'back_home')]] }
            });
        }
        
        const btns = [];
        rows.forEach(p => {
            btns.push([Markup.button.callback(`${p.name} - ${formatRp(p.price)}`, `view_${p.code}`)]);
        });
        btns.push([Markup.button.callback('🔙 Kembali', 'back_home')]);

        ctx.editMessageText('🛒 <b>Pilih Produk Digital:</b>', { parse_mode: 'HTML', reply_markup: { inline_keyboard: btns }});
    });
});

bot.action(/view_(.+)/, (ctx) => {
    const code = ctx.match[1];
    db.get('SELECT * FROM products WHERE code = ?', [code], (err, p) => {
        if (!p) return ctx.answerCbQuery('❌ Produk tidak ditemukan.');
        
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
        if (!p) return ctx.answerCbQuery('Produk tidak ditemukan.');

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
                    `<i>Harap simpan data ini. Terima kasih!</i>`;
                
                ctx.editMessageText(msgUser, {parse_mode:'HTML'});

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

// FITUR CEK KUOTA XL (API SIDOMPUL V4)
bot.action('menu_cek_kuota', (ctx) => {
    global.state[ctx.from.id] = { mode: 'INPUT_NOMOR_XL' };
    ctx.editMessageText('📊 <b>CEK KUOTA XL / AXIS</b>\n\nSilahkan kirim <b>NOMOR HP</b> yang ingin dicek.\nContoh: <code>6287812345678</code>\n\n<i>Ketik /batal untuk cancel.</i>', {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[Markup.button.callback('🔙 Batal', 'back_home')]] }
    });
});

async function processCekKuotaXL(ctx, msisdn) {
    const loadingMsg = await ctx.reply('⏳ <b>Sedang mengecek ke server Sidompul...</b>', {parse_mode: 'HTML'});
    const config = {
        method: 'get',
        url: `https://apigw.kmsp-store.com/sidompul/v4/cek_kuota`,
        params: { msisdn: msisdn, isJSON: 'true' },
        headers: { 
            'Authorization': 'Basic c2lkb21wdWxhcGk6YXBpZ3drbXNw', 
            'X-API-Key': '60ef29aa-a648-4668-90ae-20951ef90c55', 
            'X-App-Version': '4.0.0', 
            'Content-Type': 'application/x-www-form-urlencoded'
        }
    };

    try {
        const response = await axios(config);
        const res = response.data;
        if (res.status === true) {
            let cleanHasil = (res.data.hasil || "Tidak ada info.")
                .replace(/<br\s*\/?>/gi, '\n')
                .replace(/<[^>]*>?/gm, '');
            const replyText = `✅ <b>DETAIL KUOTA (${msisdn})</b>\n\n${cleanHasil}`;
            ctx.telegram.deleteMessage(loadingMsg.chat.id, loadingMsg.message_id);
            ctx.reply(replyText, { parse_mode: 'HTML' });
        } else {
            const errMsg = res.data?.keteranganError || res.message || "Gagal mengambil data.";
            ctx.telegram.deleteMessage(loadingMsg.chat.id, loadingMsg.message_id);
            ctx.reply(`❌ <b>GAGAL:</b>\n${errMsg}`, {parse_mode:'HTML'});
        }
        delete global.state[ctx.from.id];
    } catch (error) {
        ctx.telegram.deleteMessage(loadingMsg.chat.id, loadingMsg.message_id);
        ctx.reply('❌ <b>Terjadi Kesalahan!</b>\nNomor salah atau server gangguan.', {parse_mode:'HTML'});
        delete global.state[ctx.from.id];
    }
}

// FITUR TOPUP
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
        ctx.reply('❌ Gagal membuat QRIS. Coba lagi nanti.');
    }
}

// ENGINE MUTASI
async function checkMutation() {
    if (Object.keys(global.pendingDeposits).length === 0) return;

    try {
        const res = await axios.post(API_URL, buildPayload(), { headers, timeout: 5000 });
        const text = res.data;
        const incoming = [];
        if (typeof text === 'string') {
            const blocks = text.split('------------------------');
            blocks.forEach(b => {
                const m = b.match(/Kredit\s*:\s*(?:Rp\s*)?([\d.]+)/i);
                if (m) incoming.push(parseInt(m[1].replace(/\./g, '')));
            });
        }

        for (const [code, data] of Object.entries(global.pendingDeposits)) {
            if (Date.now() - data.timestamp > 5 * 60 * 1000) {
                bot.telegram.deleteMessage(data.userId, data.qrMessageId).catch(()=>{});
                delete global.pendingDeposits[code];
                db.run('DELETE FROM pending_deposits WHERE unique_code = ?', [code]);
                continue;
            }
            if (incoming.includes(data.amount)) {
                db.run('UPDATE users SET saldo = saldo + ? WHERE user_id = ?', [data.amount, data.userId]);
                bot.telegram.sendMessage(data.userId, `✅ <b>DEPOSIT BERHASIL!</b>\n\n💰 Nominal: ${formatRp(data.amount)}\n📅 Waktu: ${new Date().toLocaleString('id-ID')}`, {parse_mode:'HTML'});
                bot.telegram.deleteMessage(data.userId, data.qrMessageId).catch(()=>{});
                if (CHANNEL_ID) {
                    const quoteMsg = `<blockquote>🔔 <b>DEPOSIT RECEIVED</b>\n👤 <b>User ID:</b> ${data.userId}\n💰 <b>Amount:</b> ${formatRp(data.amount)}\n📅 <b>Date:</b> ${new Date().toLocaleString('id-ID')}</blockquote>`;
                    bot.telegram.sendMessage(CHANNEL_ID, quoteMsg, { parse_mode: 'HTML' });
                }
                delete global.pendingDeposits[code];
                db.run('DELETE FROM pending_deposits WHERE unique_code = ?', [code]);
            }
        }
    } catch (e) { }
}
const startMutationLoop = async () => { await checkMutation(); setTimeout(startMutationLoop, 10000); };
startMutationLoop();

// HANDLER TEXT & ADMIN LOGIC (INTERACTIVE)
bot.on(['text', 'photo', 'document'], async (ctx) => {
    const userId = ctx.from.id;
    const userState = global.state[userId];
    const text = ctx.message.text || '';

    // INPUT USER
    if (userState?.mode === 'INPUT_NOMOR_XL' && text) {
        if (text === '/batal') { delete global.state[userId]; return ctx.reply('❌ Batal.'); }
        if (!/^(08|628)[0-9]{8,12}$/.test(text)) return ctx.reply('⚠️ Format nomor salah! Gunakan awalan 08xx atau 628xx.');
        return processCekKuotaXL(ctx, text);
    }
    if (userState?.mode === 'INPUT_DEPOSIT' && text) {
        const amount = parseInt(text.replace(/[^0-9]/g, ''));
        if (isNaN(amount) || amount < 1000) return ctx.reply('⚠️ Minimal deposit Rp 1.000');
        return processDeposit(ctx, amount);
    }

    if (userId !== ADMIN_ID) return;

    // ADD PRODUCT WIZARD
    if (userState?.mode.startsWith('ADD_PROD_')) {
        if (text === '/batal') { delete global.state[userId]; return ctx.reply('❌ Batal tambah produk.'); }
        
        if (userState.mode === 'ADD_PROD_CODE') {
            const code = text.trim().toLowerCase().replace(/\s+/g, '_');
            db.get('SELECT code FROM products WHERE code = ?', [code], (err, row) => {
                if (row) return ctx.reply('❌ Kode sudah ada! Masukkan lain:');
                global.state[userId] = { mode: 'ADD_PROD_NAME', data: { code: code } };
                ctx.reply(`✅ Kode: ${code}\n👉 Masukkan <b>NAMA PRODUK</b>:`, {parse_mode:'HTML'});
            });
        } else if (userState.mode === 'ADD_PROD_NAME') {
            userState.data.name = text;
            global.state[userId] = { mode: 'ADD_PROD_PRICE', data: userState.data };
            ctx.reply(`✅ Nama: ${text}\n👉 Masukkan <b>HARGA</b> (Angka):`, {parse_mode:'HTML'});
        } else if (userState.mode === 'ADD_PROD_PRICE') {
            const price = parseInt(text.replace(/[^0-9]/g, ''));
            if (isNaN(price)) return ctx.reply('❌ Harga harus angka!');
            userState.data.price = price;
            global.state[userId] = { mode: 'ADD_PROD_DESC', data: userState.data };
            ctx.reply(`✅ Harga: ${price}\n👉 Masukkan <b>DESKRIPSI</b>:`, {parse_mode:'HTML'});
        } else if (userState.mode === 'ADD_PROD_DESC') {
            const d = userState.data;
            db.run('INSERT INTO products (code, name, price, description) VALUES (?, ?, ?, ?)', [d.code, d.name, d.price, text], (err) => {
                ctx.reply(`🎉 <b>Produk Ditambah!</b>\n${d.name}`, {parse_mode:'HTML'}); delete global.state[userId];
            });
        }
        return;
    }

    // EDIT PRICE
    if (userState?.mode === 'EDIT_PRICE_VAL') {
        const price = parseInt(text.replace(/[^0-9]/g, ''));
        if (isNaN(price)) return ctx.reply('❌ Harga harus angka!');
        db.run('UPDATE products SET price = ? WHERE code = ?', [price, userState.data.code], (err) => {
            ctx.reply(`✅ Harga produk <b>${userState.data.code}</b> diubah ke <b>${formatRp(price)}</b>`, {parse_mode:'HTML'});
            delete global.state[userId];
        });
        return;
    }

    // ADMIN COMMANDS
    if (text.startsWith('/addsaldo')) {
        const args = text.trim().split(/\s+/);
        const targetId = args[1];
        const amount = parseInt(args[2]);
        if (!targetId || !amount) return ctx.reply('❌ Format: /addsaldo <ID> <NOMINAL>');
        db.run('UPDATE users SET saldo = saldo + ? WHERE user_id = ?', [amount, targetId], function(err) {
            if (this.changes > 0) {
                ctx.reply('✅ Saldo ditambah.');
                bot.telegram.sendMessage(targetId, `💰 <b>BONUS SALDO</b>\nJumlah: ${formatRp(amount)}`, {parse_mode:'HTML'}).catch(()=>{});
            } else ctx.reply('❌ User ID salah.');
        });
        return;
    }

    if (text.startsWith('/addstok')) {
        const parts = text.trim().split(/\s+/);
        const code = parts[1];
        const data = parts.slice(2).join(' ');
        if (!code || !data) return ctx.reply('❌ Format: /addstok <kode> <data>');
        db.get('SELECT name FROM products WHERE code = ?', [code], (err, row) => {
            if (!row) return ctx.reply(`❌ Kode '${code}' SALAH.`);
            db.run('INSERT INTO stocks (product_code, data_account, status) VALUES (?, ?, "available")', [code, data], (err) => {
                if (!err) ctx.reply(`✅ Stok <b>${row.name}</b> ditambah!`, {parse_mode:'HTML'});
            });
        });
        return;
    }

    if (userState?.mode === 'BROADCAST') {
        if (text === '/batal') { delete global.state[userId]; return ctx.reply('❌ Batal.'); }
        ctx.reply('⏳ Mengirim broadcast...');
        delete global.state[userId];
        db.all('SELECT user_id FROM users', [], async (err, rows) => {
            let success = 0;
            for (const row of rows) {
                try {
                    if (ctx.message.photo) {
                        const photoId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
                        const caption = ctx.message.caption ? `📢 <b>INFO ADMIN</b>\n\n${ctx.message.caption}` : '';
                        await bot.telegram.sendPhoto(row.user_id, photoId, { caption: caption, parse_mode: 'HTML' });
                    } else await bot.telegram.sendMessage(row.user_id, `📢 <b>INFO ADMIN</b>\n\n${text}`, {parse_mode:'HTML'});
                    success++; await new Promise(r => setTimeout(r, 200)); 
                } catch (e) {}
            }
            ctx.reply(`✅ Terkirim ke ${success} user.`);
        });
        return;
    }

    if (userState?.mode === 'RESTORE' && ctx.message.document) {
        const doc = ctx.message.document;
        try {
            const fileLink = await ctx.telegram.getFileLink(doc.file_id);
            const writer = fs.createWriteStream('./database.sqlite');
            const response = await axios({ url: fileLink.href, method: 'GET', responseType: 'stream' });
            response.data.pipe(writer);
            writer.on('finish', () => { delete global.state[userId]; ctx.reply('✅ Restore sukses!'); initDB(); });
        } catch (e) { ctx.reply('❌ Gagal download.'); }
    }
});

// PANEL ADMIN INTERAKTIF
bot.action('admin_panel', (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    ctx.editMessageText('🔒 <b>Admin Panel v9.0</b>', {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [
            [Markup.button.callback('➕ Tambah Produk', 'add_product')],
            [Markup.button.callback('❌ Hapus Produk', 'list_delete_prod'), Markup.button.callback('💰 Ubah Harga', 'list_edit_price')],
            [Markup.button.callback('📦 Cek Stok', 'check_stock'), Markup.button.callback('📡 Broadcast', 'start_broadcast')],
            [Markup.button.callback('📤 Backup', 'force_backup'), Markup.button.callback('📥 Restore', 'start_restore')],
            [Markup.button.callback('🔙 Kembali', 'back_home')]
        ]}
    });
});

bot.action('add_product', (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    global.state[ADMIN_ID] = { mode: 'ADD_PROD_CODE' };
    ctx.reply('➕ <b>PRODUK BARU</b>\nMasukkan KODE UNIK (ex: <code>netflix_uhd</code>):', {parse_mode:'HTML'});
});

// LIST DELETE (BUTTONS)
bot.action('list_delete_prod', (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    db.all('SELECT code, name FROM products', [], (err, rows) => {
        if (!rows || rows.length === 0) return ctx.reply("Belum ada produk.");
        const btns = rows.map(r => [Markup.button.callback(`❌ ${r.name}`, `del_confirm_${r.code}`)]);
        btns.push([Markup.button.callback('🔙 Batal', 'admin_panel')]);
        ctx.editMessageText('❌ <b>Pilih Produk yg dihapus:</b>', { parse_mode: 'HTML', reply_markup: { inline_keyboard: btns } });
    });
});

bot.action(/del_confirm_(.+)/, (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    const code = ctx.match[1];
    db.run('DELETE FROM products WHERE code = ?', [code], function(err) {
        if (!err) ctx.reply(`✅ Produk <b>${code}</b> telah dihapus permanen.`, {parse_mode:'HTML'});
        // Refresh menu
        ctx.deleteMessage().catch(()=>{});
        // Optional: show admin panel again
    });
});

// LIST EDIT PRICE (BUTTONS)
bot.action('list_edit_price', (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    db.all('SELECT code, name, price FROM products', [], (err, rows) => {
        if (!rows || rows.length === 0) return ctx.reply("Belum ada produk.");
        const btns = rows.map(r => [Markup.button.callback(`💰 ${r.name} (${formatRp(r.price)})`, `edit_p_sel_${r.code}`)]);
        btns.push([Markup.button.callback('🔙 Batal', 'admin_panel')]);
        ctx.editMessageText('💰 <b>Pilih Produk yg diubah harganya:</b>', { parse_mode: 'HTML', reply_markup: { inline_keyboard: btns } });
    });
});

bot.action(/edit_p_sel_(.+)/, (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    const code = ctx.match[1];
    global.state[ADMIN_ID] = { mode: 'EDIT_PRICE_VAL', data: { code: code } };
    ctx.reply(`👉 Masukkan <b>HARGA BARU</b> untuk <code>${code}</code> (Angka saja):`, {parse_mode:'HTML'});
});

// ... (Other admin actions like check_stock, broadcast remain same as v8.0)
bot.action('check_stock', (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    getStockReport((rows) => {
        let msg = '📊 <b>STOK</b>\n\n';
        rows.forEach(r => { msg += `▫️ <b>${r.name}</b> (<code>${r.code}</code>): ${r.count} pcs\n`; });
        msg += '\n<i>Tambah: /addstok (kode) (data)</i>';
        ctx.editMessageText(msg, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[Markup.button.callback('🔙 Kembali', 'admin_panel')]] } });
    });
});
bot.action('start_broadcast', (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    global.state[ADMIN_ID] = { mode: 'BROADCAST' };
    ctx.reply('📡 Kirim pesan sekarang.');
});
bot.action('start_restore', (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    global.state[ADMIN_ID] = { mode: 'RESTORE' };
    ctx.reply('📥 Kirim file backup.');
});
bot.action('force_backup', (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    ctx.reply('⏳ Backup...'); runAutoBackup();
});

// AUTO BACKUP
const startBackupLoop = () => {
    const now = new Date();
    if (now.getHours() === 0 && now.getMinutes() === 0) runAutoBackup();
    setTimeout(startBackupLoop, 60000);
};
startBackupLoop();

function runAutoBackup() {
    const backupName = `backup_db_${new Date().toISOString().split('T')[0]}.sqlite`;
    fs.copyFile('./database.sqlite', backupName, async (err) => {
        if (!err) {
            try {
                await bot.telegram.sendDocument(ADMIN_ID, { source: backupName, filename: backupName }, {
                    caption: `📦 <b>AUTO BACKUP</b>`, parse_mode: 'HTML'
                });
                fs.unlinkSync(backupName);
            } catch (e) {}
        }
    });
}

// Start
bot.launch().then(() => console.log('🚀 BOT READY!'));
process.once('SIGINT', () => bot.stop('SIGINT'));
