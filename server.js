const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const nodemailer = require('nodemailer');
const dns = require('dns');
const db = require('./database');

// إجبار السيرفر على استخدام بروتوكول IPv4 لتفادي خطأ ENETUNREACH في Render
if (dns.setDefaultResultOrder) {
    dns.setDefaultResultOrder('ipv4first');
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// إنشاء مجلد رفع المرفقات
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

// إعداد خادم إرسال البريد الإلكتروني عبر Gmail مع إلزام الاتصال بـ IPv4
const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: {
        user: process.env.EMAIL_USER || '',
        pass: process.env.EMAIL_PASS || ''
    },
    family: 4 // منع الاتصال عبر IPv6 غير المدعوم
});

// مخزن مؤقت لرموز التأكيد
const otpStore = new Map();

// 1. مسار إرسال كود OTP إلى البريد الإلكتروني
app.post('/api/send-otp', async (req, res) => {
    const { email, username } = req.body;
    if (!email || !username) {
        return res.status(400).json({ success: false, message: 'يرجى كتابة اسم المستخدم والبريد الإلكتروني' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const cleanUsername = username.trim().toLowerCase();

    db.get('SELECT * FROM users WHERE LOWER(email) = ? OR LOWER(username) = ?', [cleanEmail, cleanUsername], async (err, user) => {
        if (err) return res.status(500).json({ success: false, message: 'خطأ في قاعدة البيانات' });
        if (user) {
            const msg = user.email.toLowerCase() === cleanEmail ? 'البريد الإلكتروني مستخدم مسبقاً' : 'اسم المستخدم محجوز بالفعل';
            return res.status(400).json({ success: false, message: msg });
        }

        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        otpStore.set(cleanEmail, { otp, expires: Date.now() + 10 * 60 * 1000 });

        console.log(`[OTP] رمز التحقق للمستخدم (${cleanUsername}) على البريد (${cleanEmail}) هو: ${otp}`);

        if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
            try {
                await transporter.sendMail({
                    from: `"WhatsApp Clone" <${process.env.EMAIL_USER}>`,
                    to: cleanEmail,
                    subject: 'رمز تأكيد حسابك في واتساب ويب',
                    html: `
            <div dir="rtl" style="font-family: Arial, sans-serif; background-color: #f0f2f5; padding: 25px; text-align: center;">
              <div style="max-width: 460px; margin: auto; background: #ffffff; padding: 30px; border-radius: 12px; border-top: 5px solid #00a884; box-shadow: 0 4px 15px rgba(0,0,0,0.05);">
                <h2 style="color: #005c4b; margin-bottom: 10px;">واتساب ويب</h2>
                <p style="color: #54656f; font-size: 15px;">أهلاً بك <b>${cleanUsername}</b>، رمز التحقق الخاص بك هو:</p>
                <div style="font-size: 32px; font-weight: bold; letter-spacing: 6px; color: #00a884; margin: 25px 0; background: #e8f5e9; padding: 14px; border-radius: 8px;">
                  ${otp}
                </div>
                <p style="color: #8696a0; font-size: 12.5px;">الرمز صالح لمدة 10 دقائق فقط. لا تشاركه مع أي طرف آخر.</p>
              </div>
            </div>
          `
                });
                return res.json({ success: true, message: 'تم إرسال كود التأكيد إلى بريدك الإلكتروني بنجاح!' });
            } catch (mailErr) {
                console.error('فشل إرسال البريد عبر Gmail:', mailErr.message);
                return res.status(500).json({
                    success: false,
                    message: 'فشل إرسال البريد. تحقق من صحة بيانات EMAIL_USER و EMAIL_PASS في Render.'
                });
            }
        } else {
            return res.status(500).json({
                success: false,
                message: 'بيانات البريد غير معرّفة في تبويب Environment في Render.'
            });
        }
    });
});

// 2. مسار التحقق من الرمز وإنشاء الحساب
app.post('/api/register', (req, res) => {
    const { username, email, password, otp } = req.body;
    if (!username || !email || !password || !otp) {
        return res.status(400).json({ success: false, message: 'يرجى ملء جميع الحقول ورمز التحقق' });
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
        return res.json({ success: true, message: 'تم تفعيل وإنشاء حسابك بنجاح! يمكنك الآن تسجيل الدخول' });
    });
});

// 3. مسار تسجيل الدخول
app.post('/api/login', (req, res) => {
    const { identifier, password } = req.body;
    if (!identifier || !password) {
        return res.status(400).json({ success: false, message: 'يرجى إدخال اسم المستخدم/البريد وكلمة المرور' });
    }

    const cleanId = identifier.trim().toLowerCase();
    db.get('SELECT * FROM users WHERE (LOWER(email) = ? OR LOWER(username) = ?) AND password = ?', [cleanId, cleanId, password], (err, user) => {
        if (err) return res.status(500).json({ success: false, message: 'خطأ داخلي في الخادم' });
        if (!user) return res.status(400).json({ success: false, message: 'بيانات الدخول غير صحيحة، تأكد من بياناتك' });
        return res.json({ success: true, username: user.username, email: user.email });
    });
});

// 4. جلب جهات الاتصال
app.get('/api/users', (req, res) => {
    const current = (req.query.current || '').toLowerCase();
    db.all('SELECT username, email FROM users WHERE LOWER(username) != ? ORDER BY username ASC', [current], (err, rows) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        res.json({ success: true, users: rows || [] });
    });
});

// 5. رفع الملفات والصوتيات
app.post('/api/upload', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, message: 'لم يتم رفع أي ملف' });
    res.json({
        success: true,
        fileUrl: `/uploads/${req.file.filename}`,
        fileName: req.file.originalname
    });
});

// 6. إدارة اتصالات Socket.io ومكالمات الصوت والفيديو المباشرة (WebRTC Signaling)
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

    // مكالمات الصوت والفيديو (WebRTC)
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
        }
    });
});

server.listen(PORT, () => {
    console.log(`السيرفر يعمل الآن على المنفذ: ${PORT}`);
});