// Envio de emails via Resend (HTTPS). Evita el bloqueo de SMTP en Render.
//
// Requiere la variable de entorno RESEND_API_KEY (empieza con "re_").
// Opcional: RESEND_FROM. Si no la ponés, se usa "onboarding@resend.dev"
// (el remitente de prueba de Resend, que funciona sin verificar dominio).

var API_URL = 'https://api.resend.com/emails';

function getApiKey() {
  return process.env.RESEND_API_KEY || '';
}

function getFrom() {
  return process.env.RESEND_FROM || 'Administracion Consorcio <onboarding@resend.dev>';
}

function describir(e) {
  if (!e) return 'error desconocido';
  if (typeof e === 'string') return e;
  return e.message || JSON.stringify(e);
}

async function enviar(to, subject, text) {
  var apiKey = getApiKey();
  if (!apiKey) {
    console.log('[MAILER] Falta RESEND_API_KEY. No se envia a', to);
    return { ok: false, error: 'Falta RESEND_API_KEY' };
  }
  if (!to) {
    console.log('[MAILER] Destinatario vacio para:', subject);
    return { ok: false, error: 'Destinatario vacio' };
  }
  try {
    var res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: getFrom(),
        to: [to],
        subject: subject,
        text: text
      })
    });
    var data = null;
    try { data = await res.json(); } catch (_) { data = null; }
    if (!res.ok) {
      var msg = (data && (data.message || data.error || data.name)) || ('HTTP ' + res.status);
      console.log('[MAILER] ERROR enviando a', to, ':', msg);
      return { ok: false, error: msg };
    }
    var id = (data && data.id) || 'ok';
    console.log('[MAILER] Enviado a', to, '->', id);
    return { ok: true, id: id };
  } catch (e) {
    console.log('[MAILER] Excepcion enviando a', to, ':', describir(e));
    return { ok: false, error: describir(e) };
  }
}

async function verificar() {
  var apiKey = getApiKey();
  if (!apiKey) return { ok: false, error: 'Falta RESEND_API_KEY' };
  // Resend no expone un endpoint /verify; consideramos "listo" si la clave existe.
  return { ok: true };
}

// Se mantiene por compatibilidad con codigo que llamaba a getTransport(); no lo usa nadie via HTTP.
function getTransport() { return null; }

module.exports = { enviar: enviar, verificar: verificar, getTransport: getTransport };
