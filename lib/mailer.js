var nodemailer = require('nodemailer');

var transporter = null;

// Devuelve un transporter de Gmail, o null si faltan las credenciales.
function getTransport() {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.SMTP_USER,
        // El App Password de Gmail suele copiarse con espacios cada 4 caracteres.
        // Los quitamos para evitar el error de autenticacion mas comun.
        pass: String(process.env.SMTP_PASS).replace(/\s+/g, '')
      }
    });
  }
  return transporter;
}

// Envia un mail. Nunca tira excepcion hacia arriba: devuelve {ok, error}.
// Loguea siempre el resultado para poder diagnosticar desde los logs de Render.
async function enviar(to, subject, text) {
  var tr = getTransport();
  if (!tr) {
    console.log('[MAILER] SMTP no configurado (faltan SMTP_USER / SMTP_PASS). No se envia a', to);
    return { ok: false, error: 'SMTP no configurado' };
  }
  if (!to) {
    console.log('[MAILER] Destinatario vacio para el asunto:', subject);
    return { ok: false, error: 'Destinatario vacio' };
  }
  try {
    var info = await tr.sendMail({
      from: 'Administracion Consorcio <' + process.env.SMTP_USER + '>',
      to: to,
      subject: subject,
      text: text
    });
    console.log('[MAILER] Enviado a', to, '->', info.messageId);
    return { ok: true, id: info.messageId };
  } catch (e) {
    console.log('[MAILER] ERROR enviando a', to, ':', e.message);
    return { ok: false, error: e.message };
  }
}

// Verifica la conexion/credenciales SMTP (para el boton de prueba del admin).
async function verificar() {
  var tr = getTransport();
  if (!tr) return { ok: false, error: 'SMTP no configurado (faltan SMTP_USER / SMTP_PASS)' };
  try {
    await tr.verify();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { enviar: enviar, verificar: verificar, getTransport: getTransport };
