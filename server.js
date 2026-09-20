const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const nodemailer = require('nodemailer');
const db = require('./database');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// مجلد المرفقات
const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname) || (file.mimetype.includes('audio') ? '.webm' : '');
        cb(null, Date.now() + '-' + Math.round(Math.random() * 1e9) + ext);
    }
});
const upload = multer({ storage });

// إعداد البريد الإلكتروني
const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: {
        user: process.env.EMAIL_USER || '',
        pass: process.env.EMAIL_PASS || ''
    },
    family: 4,
    connectionTimeout: 3000
});

const otpStore = new Map();

// 1. مسار إرسال رمز OTP الفوري
app.post('/api/send-otp', (req, res) => {
    const { email, username } = req.body;
    if (!email || !username) {
        return res.status(400).json({ success: false, message: 'يرجى إدخال اسم المستخدم والبريد' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const cleanUsername = username.trim().toLowerCase();

    db.get('SELECT * FROM users WHERE LOWER(email) = ? OR LOWER(username) = ?', [cleanEmail, cleanUsername], (err, user) => {
        if (err) return res.status(500).json({ success: false, message: 'خطأ في قاعدة البيانات' });
        if (user) {
            const msg = user.email.toLowerCase() === cleanEmail ? 'البريد الإلكتروني مسجل مسبقاً' : 'اسم المستخدم محجوز مسبقاً';
            return res.status(400).json({ success: false, message: msg });
        }

        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        otpStore.set(cleanEmail, { otp, expires: Date.now() + 10 * 60 * 1000 });

        console.log(`[OTP] رمز التحقق لـ (${cleanUsername}): ${otp}`);

        if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
            transporter.sendMail({
                from: `"WhatsApp Web" <${process.env.EMAIL_USER}>`,
                to: cleanEmail,
                subject: 'رمز تأكيد حسابك في واتساب ويب',
                html: `<h3>رمز التحقق الخاص بك هو: <b>${otp}</b></h3>`
            }).catch(() => { });
        }

        return res.json({
            success: true,
            otp: otp,
            message: `تم إنشاء رمز التأكيد بنجاح: <b>${otp}</b>`
        });
    });
});

// 2. إنشاء وتفعيل الحساب
app.post('/api/register', (req, res) => {
    const { username, email, password, otp } = req.body;
    if (!username || !email || !password || !otp) {
        return res.status(400).json({ success: false, message: 'يرجى تعبئة كافة الحقول' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const cleanUsername = username.trim().toLowerCase();

    const record = otpStore.get(cleanEmail);
    if (!record || record.otp !== otp.trim() || Date.now() > record.expires) {
        return res.status(400).json({ success: false, message: 'رمز التأكيد غير صحيح أو منتهي الصلاحية' });
    }

    db.run('INSERT INTO users (username, email, password) VALUES (?, ?, ?)', [cleanUsername, cleanEmail, password], function (err) {
        if (err) return res.status(400).json({ success: false, message: 'تعذر إنشاء الحساب: ' + err.message });
        otpStore.delete(cleanEmail);

        // إشعار جميع الأجهزة المتصلة لتحديث قائمة الحسابات فوراً
        io.emit('refresh_users');

        return res.json({ success: true, message: 'تم إنشاء الحساب بنجاح! سجّل دخولك الآن' });
    });
});

// 3. تسجيل الدخول
app.post('/api/login', (req, res) => {
    const { identifier, password } = req.body;
    if (!identifier || !password) {
        return res.status(400).json({ success: false, message: 'يرجى ملء جميع الحقول' });
    }

    const cleanId = identifier.trim().toLowerCase();
    db.get('SELECT * FROM users WHERE (LOWER(email) = ? OR LOWER(username) = ?) AND password = ?', [cleanId, cleanId, password], (err, user) => {
        if (err) return res.status(500).json({ success: false, message: 'خطأ داخلي' });
        if (!user) return res.status(400).json({ success: false, message: 'بيانات الدخول غير صحيحة، يرجى إنشاء حساب جديد أولاً' });

        // إشعار الأجهزة لتحديث القائمة فور الدخول
        io.emit('refresh_users');

        return res.json({ success: true, username: user.username, email: user.email });
    });
});

// 4. جلب جميع المستخدمين
app.get('/api/users', (req, res) => {
    const current = (req.query.current || '').toLowerCase();
    db.all('SELECT username, email FROM users ORDER BY username ASC', [], (err, rows) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        const filtered = (rows || []).filter(u => u.username.toLowerCase() !== current);
        res.json({ success: true, users: filtered });
    });
});

// 5. رفع الملفات والصوتيات
app.post('/api/upload', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, message: 'لم يتم اختيار ملف' });
    res.json({ success: true, fileUrl: `/uploads/${req.file.filename}`, fileName: req.file.originalname });
});

// 6. إدارة الدردشة ومكالمات الصوت والفيديو (WebRTC)
const onlineUsers = new Map();

io.on('connection', (socket) => {
    socket.on('user_connected', (username) => {
        if (!username) return;
        const u = username.toLowerCase();
        socket.username = u;
        onlineUsers.set(u, socket.id);
        io.emit('online_users', Array.from(onlineUsers.keys()));
        io.emit('refresh_users');
    });

    socket.on('get_history', ({ sender, receiver }) => {
        if (!sender || !receiver) return;
        db.all(
            `SELECT * FROM messages 
       WHERE (LOWER(sender) = ? AND LOWER(receiver) = ?) OR (LOWER(sender) = ? AND LOWER(receiver) = ?) 
       ORDER BY timestamp ASC LIMIT 200`,
            [sender.toLowerCase(), receiver.toLowerCase(), receiver.toLowerCase(), sender.toLowerCase()],
            (err, rows) => {
                if (!err && rows) socket.emit('chat_history', { receiver: receiver.toLowerCase(), messages: rows });
            }
        );
    });

    socket.on('private_message', (data) => {
        const { sender, receiver, type, content, fileName } = data;
        if (!sender || !receiver || !content) return;
        const s = sender.toLowerCase();
        const r = receiver.toLowerCase();

        db.run(
            'INSERT INTO messages (sender, receiver, type, content, file_name) VALUES (?, ?, ?, ?, ?)',
            [s, r, type || 'text', content, fileName || ''],
            function (err) {
                if (!err) {
                    const msg = {
                        id: this.lastID,
                        sender: s,
                        receiver: r,
                        type: type || 'text',
                        content,
                        fileName: fileName || '',
                        timestamp: new Date().toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })
                    };
                    socket.emit('message_received', msg);
                    const target = onlineUsers.get(r);
                    if (target) io.to(target).emit('message_received', msg);
                }
            }
        );
    });

    // مكالمات WebRTC
    socket.on('call_user', ({ to, offer, isVideo, from }) => {
        const targetSocket = onlineUsers.get(to.toLowerCase());
        if (targetSocket) {
            io.to(targetSocket).emit('incoming_call', { from, offer, isVideo });
        } else {
            socket.emit('call_failed', { message: 'المستخدم غير متصل حالياً' });
        }
    });

    socket.on('answer_call', ({ to, answer }) => {
        const targetSocket = onlineUsers.get(to.toLowerCase());
        if (targetSocket) io.to(targetSocket).emit('call_accepted', { answer });
    });

    socket.on('ice_candidate', ({ to, candidate }) => {
        const targetSocket = onlineUsers.get(to.toLowerCase());
        if (targetSocket) io.to(targetSocket).emit('ice_candidate', { candidate });
    });

    socket.on('reject_call', ({ to }) => {
        const targetSocket = onlineUsers.get(to.toLowerCase());
        if (targetSocket) io.to(targetSocket).emit('call_rejected');
    });

    socket.on('end_call', ({ to }) => {
        const targetSocket = onlineUsers.get(to.toLowerCase());
        if (targetSocket) io.to(targetSocket).emit('call_ended');
    });

    socket.on('disconnect', () => {
        if (socket.username) {
            onlineUsers.delete(socket.username);
            io.emit('online_users', Array.from(onlineUsers.keys()));
            io.emit('refresh_users');
        }
    });
});

server.listen(PORT, () => {
    console.log(`السيرفر يعمل الآن على المنفذ: ${PORT}`);
});