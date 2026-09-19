const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'database.sqlite');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('خطأ الاتصال بقاعدة البيانات:', err.message);
  } else {
    console.log('تم الاتصال بقاعدة بيانات SQLite بنجاح');
  }
});

// إنشاء الجداول تلقائياً لضمان استقرار السيرفر
db.serialize(() => {
  // جدول المستخدمين مع دعم البريد الإلكتروني
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      avatar TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // جدول الرسائل
  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender TEXT NOT NULL,
      receiver TEXT NOT NULL,
      type TEXT DEFAULT 'text',
      content TEXT NOT NULL,
      file_name TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
});

module.exports = db;