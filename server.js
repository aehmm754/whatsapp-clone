const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const multer = require('multer');
const db = require('./database');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// مجلد الوسائط
const uploadDir = path.join(__dirname, 'public/uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
});
const upload = multer({ storage });

// إعداد خدمة الإيميل
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: 'aehmkk754@gmail.com',
        pass: 'hhbakzplnqeeetrx'
    }
});

// مسارات المصادقة
app.post('/api/register', async (req, res) => {
    const { username, email, password } = req.body;
    if (!username || !email || !password) return res.status(400).json({ error: 'يرجى إكمال الحقول' });

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const otp = Math.floor(100000 + Math.random() * 900000).toString();

        db.run(
            `INSERT INTO users (username, email, password, otp) VALUES (?, ?, ?, ?)`,
            [username, email, hashedPassword, otp],
            async function (err) {
                if (err) return res.status(400).json({ error: 'اليوزر أو الإيميل مستخدم مسبقاً' });

                try {
                    await transporter.sendMail({
                        from: '"واتساب ويب" <aehmkk754@gmail.com>',
                        to: email,
                        subject: 'رمز تفعيل حسابك',
                        text: `رمز التحقق الخاص بك هو: ${otp}`
                    });
                    res.json({ message: 'تم إرسال رمز التحقق إلى بريدك' });
                } catch {
                    res.status(500).json({ error: 'فشل إرسال الإيميل' });
                }
            }
        );
    } catch {
        res.status(500).json({ error: 'خطأ داخلي في الخادم' });
    }
});

app.post('/api/verify', (req, res) => {
    const { email, otp } = req.body;
    db.get(`SELECT * FROM users WHERE email = ? AND otp = ?`, [email, otp], (err, user) => {
        if (err || !user) return res.status(400).json({ error: 'رمز التحقق غير صحيح' });
        db.run(`UPDATE users SET is_verified = 1, otp = NULL WHERE id = ?`, [user.id], () => {
            res.json({ message: 'تم التفعيل بنجاح!' });
        });
    });
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    db.get(`SELECT * FROM users WHERE username = ?`, [username], async (err, user) => {
        if (err || !user) return res.status(400).json({ error: 'بيانات غير صحيحة' });
        if (!user.is_verified) return res.status(403).json({ error: 'يرجى تفعيل الحساب أولاً' });

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.status(400).json({ error: 'بيانات غير صحيحة' });

        res.json({ user: { id: user.id, username: user.username } });
    });
});

// البحث وجهات الاتصال
app.get('/api/users/search', (req, res) => {
    const { q, currentUserId } = req.query;
    db.all(
        `SELECT id, username FROM users WHERE username LIKE ? AND id != ? AND is_verified = 1 LIMIT 10`,
        [`%${q}%`, currentUserId],
        (err, rows) => res.json(rows || [])
    );
});

app.post('/api/requests/send', (req, res) => {
    const { senderId, receiverId } = req.body;
    db.run(
        `INSERT INTO contact_requests (sender_id, receiver_id, status) VALUES (?, ?, 'pending')`,
        [senderId, receiverId],
        function (err) {
            if (err) return res.status(400).json({ error: 'الطلب موجود بالفعل' });
            io.to(`user_${receiverId}`).emit('new_request');
            res.json({ message: 'تم إرسال الطلب بنجاح' });
        }
    );
});

app.get('/api/contacts/data', (req, res) => {
    const { userId } = req.query;
    db.all(
        `SELECT r.id as requestId, u.id as userId, u.username 
     FROM contact_requests r JOIN users u ON r.sender_id = u.id 
     WHERE r.receiver_id = ? AND r.status = 'pending'`,
        [userId],
        (err, pendingRequests) => {
            db.all(
                `SELECT DISTINCT u.id, u.username FROM users u
         JOIN contact_requests r ON (r.sender_id = u.id AND r.receiver_id = ?) 
                                 OR (r.receiver_id = u.id AND r.sender_id = ?)
         WHERE r.status = 'accepted'`,
                [userId, userId],
                (err2, contacts) => {
                    res.json({ pendingRequests: pendingRequests || [], contacts: contacts || [] });
                }
            );
        }
    );
});

app.post('/api/requests/respond', (req, res) => {
    const { requestId, status } = req.body;
    db.run(`UPDATE contact_requests SET status = ? WHERE id = ?`, [status, requestId], () => {
        res.json({ message: 'تم تحديث حالة الطلب' });
    });
});

app.get('/api/messages', (req, res) => {
    const { userId, targetId } = req.query;
    db.all(
        `SELECT * FROM messages 
     WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?) 
     ORDER BY timestamp ASC`,
        [userId, targetId, targetId, userId],
        (err, rows) => res.json(rows || [])
    );
});

app.post('/api/upload', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'لا يوجد ملف' });
    res.json({ fileUrl: `/uploads/${req.file.filename}` });
});

// نظام التراسل وإشارات المكالمات الحية
io.on('connection', (socket) => {
    socket.on('join', (userId) => {
        socket.userId = userId;
        socket.join(`user_${userId}`);
    });

    socket.on('send_private_message', (data) => {
        const { senderId, receiverId, type, content } = data;
        db.run(
            `INSERT INTO messages (sender_id, receiver_id, type, content) VALUES (?, ?, ?, ?)`,
            [senderId, receiverId, type, content],
            function () {
                const msg = { ...data, timestamp: new Date() };
                io.to(`user_${receiverId}`).emit('receive_private_message', msg);
                io.to(`user_${senderId}`).emit('receive_private_message', msg);
            }
        );
    });

    // بدء المكالمة (صوتية أو فيديو)
    socket.on('call_user', ({ userToCall, signalData, callerId, callerName, isVideo }) => {
        io.to(`user_${userToCall}`).emit('incoming_call', {
            signal: signalData,
            from: callerId,
            callerName: callerName,
            isVideo: isVideo
        });
    });

    socket.on('accept_call', ({ to, signal }) => {
        io.to(`user_${to}`).emit('call_accepted', signal);
    });

    socket.on('ice_candidate', ({ to, candidate }) => {
        io.to(`user_${to}`).emit('ice_candidate', candidate);
    });

    // إغلاق المكالمة متزامناً لدى الطرفين
    socket.on('end_call', ({ to }) => {
        if (to) {
            io.to(`user_${to}`).emit('call_ended');
        }
    });
});

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`السيرفر يعمل الآن على: http://localhost:${PORT}`);
});