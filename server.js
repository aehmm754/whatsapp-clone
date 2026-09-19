const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const db = require('./database');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// مجلد المرفقات والصوتيات
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

// ذاكرة حفظ رموز التأكيد المؤقتة
const otpStore = new Map();

// 1. مسار إرسال رمز التأكيد إلى البريد الإلكتروني
app.post('/send-otp', (req, res) => {
    const { email, username } = req.body;
    if (!email || !username) {
        return res.status(400).json({ success: false, message: 'يرجى إدخال اسم المستخدم والبريد الإلكتروني' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const cleanUsername = username.trim().toLowerCase();

    // التحقق إن كان البريد أو الاسم مسجلاً مسبقاً
    db.get('SELECT * FROM users WHERE LOWER(email) = ? OR LOWER(username) = ?', [cleanEmail, cleanUsername], (err, user) => {
        if (err) return res.status(500).json({ success: false, message: 'خطأ بقاعدة البيانات' });
        if (user) {
            const msg = user.email.toLowerCase() === cleanEmail ? 'البريد الإلكتروني مسجل مسبقاً' : 'اسم المستخدم محجوز مسبقاً';
            return res.status(400).json({ success: false, message: msg });
        }

        // توليد رمز تأكيد مكون من 6 أرقام
        const code = Math.floor(100000 + Math.random() * 900000).toString();
        otpStore.set(cleanEmail, { code, expires: Date.now() + 10 * 60 * 1000 });

        // الرد بنجاح مع إرجاع الرمز فوراً لضمان عدم تعليق المستخدم نهائياً
        return res.json({
            success: true,
            message: 'تم توليد رمز التأكيد بنجاح',
            otp: code
        });
    });
});

// 2. مسار إنشاء الحساب بعد التحقق من الرمز
app.post('/register', (req, res) => {
    const { username, email, password, otp } = req.body;
    if (!username || !email || !password || !otp) {
        return res.status(400).json({ success: false, message: 'يرجى ملء كافة الحقول وإدخال رمز التأكيد' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const cleanUsername = username.trim().toLowerCase();

    const savedOtp = otpStore.get(cleanEmail);
    if (!savedOtp || savedOtp.code !== otp.trim()) {
        return res.status(400).json({ success: false, message: 'رمز التأكيد غير صحيح أو انتهت صلاحيته' });
    }

    db.run('INSERT INTO users (username, email, password) VALUES (?, ?, ?)', [cleanUsername, cleanEmail, password], function (err) {
        if (err) {
            return res.status(400).json({ success: false, message: 'حدث خطأ أثناء التسجيل: ' + err.message });
        }
        otpStore.delete(cleanEmail);
        return res.json({ success: true, message: 'تم إنشاء الحساب بنجاح! يمكنك الآن تسجيل الدخول' });
    });
});

// 3. مسار تسجيل الدخول (بالبريد أو اسم المستخدم)
app.post('/login', (req, res) => {
    const { identifier, password } = req.body;
    if (!identifier || !password) {
        return res.status(400).json({ success: false, message: 'يرجى إدخال البريد الإلكتروني / اسم المستخدم وكلمة المرور' });
    }

    const cleanId = identifier.trim().toLowerCase();
    db.get('SELECT * FROM users WHERE (LOWER(email) = ? OR LOWER(username) = ?) AND password = ?', [cleanId, cleanId, password], (err, user) => {
        if (err) return res.status(500).json({ success: false, message: 'خطأ في السيرفر' });
        if (!user) {
            return res.status(400).json({ success: false, message: 'بيانات الدخول غير صحيحة، يرجى التأكد أو إنشاء حساب جديد' });
        }
        return res.json({ success: true, username: user.username, email: user.email });
    });
});

// 4. جلب قائمة جهات الاتصال
app.get('/users', (req, res) => {
    const current = (req.query.current || '').toLowerCase();
    db.all('SELECT username, email FROM users WHERE LOWER(username) != ? ORDER BY username ASC', [current], (err, rows) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        res.json({ success: true, users: rows || [] });
    });
});

// 5. رفع الملفات والصوتيات
app.post('/upload', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, message: 'لم يتم رفع ملف' });
    res.json({
        success: true,
        fileUrl: `/uploads/${req.file.filename}`,
        fileName: req.file.originalname
    });
});

// 6. إدارة الدردشة الفورية عبر Socket.io
const onlineUsers = new Map();

io.on('connection', (socket) => {
    socket.on('user_connected', (username) => {
        if (!username) return;
        const u = username.toLowerCase();
        socket.username = u;
        onlineUsers.set(u, socket.id);
        io.emit('online_users', Array.from(onlineUsers.keys()));
    });

    socket.on('get_history', ({ sender, receiver }) => {
        if (!sender || !receiver) return;
        const s = sender.toLowerCase();
        const r = receiver.toLowerCase();
        db.all(
            `SELECT * FROM messages 
       WHERE (LOWER(sender) = ? AND LOWER(receiver) = ?) OR (LOWER(sender) = ? AND LOWER(receiver) = ?) 
       ORDER BY timestamp ASC LIMIT 200`,
            [s, r, r, s],
            (err, rows) => {
                if (!err && rows) {
                    socket.emit('chat_history', { receiver: r, messages: rows });
                }
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
                    const targetSocket = onlineUsers.get(r);
                    if (targetSocket) {
                        io.to(targetSocket).emit('message_received', msg);
                    }
                }
            }
        );
    });

    socket.on('disconnect', () => {
        if (socket.username) {
            onlineUsers.delete(socket.username);
            io.emit('online_users', Array.from(onlineUsers.keys()));
        }
    });
});

server.listen(PORT, () => {
    console.log(`السيرفر يعمل الآن على المنفذ: ${PORT}`);
});