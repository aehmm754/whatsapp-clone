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

// مجلد حفظ الملفات والتسجيلات الصوتية
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

// إنشاء حساب جديد
app.post('/register', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ success: false, message: 'يرجى إدخال اسم المستخدم وكلمة المرور' });
    }

    const cleanUser = username.trim().toLowerCase();
    db.run('INSERT INTO users (username, password) VALUES (?, ?)', [cleanUser, password], function (err) {
        if (err) {
            if (err.message.includes('UNIQUE')) {
                return res.status(400).json({ success: false, message: 'اسم المستخدم هذا مسجل مسبقاً، اختر اسماً آخر' });
            }
            return res.status(500).json({ success: false, message: 'خطأ في الخادم: ' + err.message });
        }
        return res.json({ success: true, message: 'تم إنشاء الحساب بنجاح! يمكنك الآن تسجيل الدخول' });
    });
});

// تسجيل الدخول
app.post('/login', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ success: false, message: 'يرجى إدخال البيانات كاملة' });
    }

    const cleanUser = username.trim().toLowerCase();
    db.get('SELECT * FROM users WHERE username = ? AND password = ?', [cleanUser, password], (err, user) => {
        if (err) return res.status(500).json({ success: false, message: 'خطأ في السيرفر' });
        if (!user) {
            return res.status(400).json({ success: false, message: 'البيانات غير صحيحة، يرجى التأكد أو إنشاء حساب جديد' });
        }
        return res.json({ success: true, username: user.username });
    });
});

// جلب قائمة المستخدمين
app.get('/users', (req, res) => {
    const current = (req.query.current || '').toLowerCase();
    db.all('SELECT username FROM users WHERE username != ? ORDER BY username ASC', [current], (err, rows) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        res.json({ success: true, users: rows || [] });
    });
});

// رفع الصور والتسجيلات الصوتية
app.post('/upload', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, message: 'لم يتم رفع أي ملف' });
    res.json({ success: true, fileUrl: `/uploads/${req.file.filename}` });
});

// إدارة الاتصالات الفورية عبر Socket.io
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
       WHERE (sender = ? AND receiver = ?) OR (sender = ? AND receiver = ?) 
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
        const { sender, receiver, type, content } = data;
        if (!sender || !receiver || !content) return;
        const s = sender.toLowerCase();
        const r = receiver.toLowerCase();

        db.run(
            'INSERT INTO messages (sender, receiver, type, content) VALUES (?, ?, ?, ?)',
            [s, r, type || 'text', content],
            function (err) {
                if (!err) {
                    const msg = {
                        id: this.lastID,
                        sender: s,
                        receiver: r,
                        type: type || 'text',
                        content,
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