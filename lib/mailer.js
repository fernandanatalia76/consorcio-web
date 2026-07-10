var nodemailer = require('nodemailer');

var transporter = null;

function getTransport() {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 587,
      secure: false,        // STARTTLS (suele ser el mas compatible en la nube)
      requireTLS: true,
      auth: {
        user: process.env.SMTP_USER,
        // El App Password de Gmail se copia con espacios; los sacamos.
        pass: String(process.env.SMTP_PASS).replace(/\s+/g, '')
      },
      // Que no se cuelgue: si no conecta en unos segundos, falla y avisa.
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000
    });
  }
  return transporter;
}

function describir(e) {
  var code = e && e.code ? '[' + e.code + '] ' : '';
  var msg = e && e.message ? e.message : String(e);
  return code + msg;
}

async function enviar(to, subject, text) {
  var tr = getTransport();
  if (!tr) {
    console.log('[MAILER] SMTP no configurado (faltan SMTP_USER / SMTP_PASS). No se envia a', to);
    return { ok: false, error: 'SMTP no configurado' };
  }
  if (!to) {
    console.log('[MAILER] Destinatario vacio para:', subject);
    return { ok: false, error: 'Destinatario vacio' };
  }
  try {
    var info = await tr.sendMail({
      from: 'Administracion Consorcio <' + process.env.SMTP_USER + '>',
      to: to, subject: subject, text: text
    });
    console.log('[MAILER] Enviado a', to, '->', info.messageId);
    return { ok: true, id: info.messageId };
  } catch (e) {
    console.log('[MAILER] ERROR enviando a', to, ':', describir(e));
    return { ok: false, error: describir(e) };
  }
}

async function verificar() {
  var tr = getTransport();
  if (!tr) return { ok: false, error: 'SMTP no configurado (faltan SMTP_USER / SMTP_PASS)' };
  try {
    await tr.verify();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: describir(e) };
  }
}

module.exports = { enviar: enviar, verificar: verificar, getTransport: getTransport };
