# SNTAT — دليل النشر على Render

## 1) GitHub
أنشئ مستودعاً جديداً فارغاً، ثم ارفع **محتويات** هذا المجلد (وليس المجلد نفسه) بحيث يظهر `server.js` و`package.json` في الجذر.

## 2) قاعدة البيانات
Render ← New ← PostgreSQL ← أنشئها، ثم انسخ **Internal Database URL**.
(الجداول تُنشأ تلقائياً عند أول تشغيل من ملف schema.sql)

## 3) الخدمة
Render ← New ← Web Service ← اختر المستودع.
- Runtime: Node
- Build Command: `npm install`
- Start Command: `npm start`
- Environment Variables:
  - `DATABASE_URL` = الرابط الداخلي للقاعدة (نفس المنطقة Region)
  - `JWT_SECRET` = نص عشوائي طويل (32 حرفاً فأكثر)
  - `ADMIN_EMAIL` = بريدك (الحساب الذي يسجّل بهذا البريد يصبح أدمن تلقائياً)
  - `RESEND_API_KEY` = مفتاح Resend لإرسال رمز OTP
  - `MAIL_FROM` = مثال: `SNTAT <no-reply@yourdomain.com>`

## 4) البريد (OTP)
- أنشئ حساباً في resend.com وأنشئ API Key.
- بدون ربط نطاقك (Domain) لن تصل الرسائل إلا لبريد حسابك في Resend.
- إذا لم تضع `RESEND_API_KEY` يُطبع الرمز في سجلات Render (Logs) للتجربة فقط.

## 5) الاستخدام
- التطبيق: `https://اسم-خدمتك.onrender.com`
- لوحة التحكم: `/admin.html` (للأدمن فقط)
- أي push جديد على GitHub يُنشر تلقائياً.

## ملاحظات
- الخطة المجانية في Render تنام بعد فترة خمول فيتأخر أول طلب.
- قاعدة Render المجانية قد تنتهي مدتها؛ للبيانات الحقيقية استخدم خطة مدفوعة.
- بيع وسحب المال الحقيقي يحتاج بوابة دفع وامتثالاً قانونياً قبل الإطلاق.
