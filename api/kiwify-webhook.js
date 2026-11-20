// TRI DIGITAL — MIV | Webhook Kiwify + Supabase + Resend
// Endpoint: /api/kiwify-webhook
//
// Variáveis necessárias na Vercel:
// SUPABASE_URL
// SUPABASE_SERVICE_ROLE_KEY (ou SUPABASE_SECRET_KEY)
// RESEND_API_KEY
// KIWIFY_WEBHOOK_TOKEN
// Opcional: KIWIFY_PRODUCT_ID

const crypto = require("crypto");

const json = (res, status, body) => res.status(status).json(body);

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function isValidKiwifySignature(rawBody, receivedSignature, secret) {
  if (!rawBody || !receivedSignature || !secret) return false;
  const expected = crypto.createHmac("sha1", secret).update(rawBody).digest("hex");
  const received = String(receivedSignature).trim().toLowerCase();
  const expectedBuffer = Buffer.from(expected, "hex");
  const receivedBuffer = Buffer.from(received, "hex");
  return (
    receivedBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(receivedBuffer, expectedBuffer)
  );
}

function safeTokenMatch(received, expected) {
  if (!received || !expected) return false;
  const a = Buffer.from(String(received));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function makeAccessKey() {
  const raw = crypto.randomBytes(9).toString("hex").toUpperCase();
  return `MIV-${raw.slice(0, 6)}-${raw.slice(6, 12)}-${raw.slice(12)}`;
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return json(res, 405, { ok: false, error: "Método não permitido." });
  }

  const kiwifyToken = process.env.KIWIFY_WEBHOOK_TOKEN;
  if (!kiwifyToken) {
    console.error("KIWIFY_WEBHOOK_TOKEN não configurado.");
    return json(res, 500, { ok: false, error: "Webhook não configurado." });
  }

  let rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch (error) {
    console.error("Não foi possível ler o corpo original do webhook:", error);
    return json(res, 400, { ok: false, error: "Corpo do webhook inválido." });
  }

  const signature = req.query?.signature;
  if (!isValidKiwifySignature(rawBody, signature, kiwifyToken)) {
    return json(res, 401, { ok: false, error: "Assinatura Kiwify inválida." });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return json(res, 400, { ok: false, error: "JSON inválido." });
  }

  // Modo de teste seguro: valida assinatura e JSON, mas não cria chaves nem envia e-mails.
  if (process.env.KIWIFY_WEBHOOK_TEST_MODE === "true") {
    return json(res, 200, {
      ok: true,
      testMode: true,
      signatureValid: true,
      eventType: payload.webhook_event_type || null,
      orderStatus: payload.order_status || null,
      orderIdReceived: Boolean(payload.order_id),
    });
  }

  const supabaseUrl = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
  const supabaseKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SECRET_KEY ||
    "";
  const resendKey = process.env.RESEND_API_KEY;

  if (!supabaseUrl || !supabaseKey) {
    console.error("Configuração ausente: Supabase.");
    return json(res, 500, { ok: false, error: "Integração não configurada." });
  }

  const headers = {
    apikey: supabaseKey,
    Authorization: `Bearer ${supabaseKey}`,
    "Content-Type": "application/json",
    Prefer: "return=representation",
  };

  const tableUrl = `${supabaseUrl}/rest/v1/miv_access_keys`;

  async function findOrder(orderId) {
    const url =
      `${tableUrl}?kiwify_order_id=eq.${encodeURIComponent(orderId)}` +
      "&select=id,access_key,buyer_email,status,email_sent_at,email_sending_at&limit=1";
    const response = await fetch(url, { headers });
    const data = await response.json().catch(() => []);
    if (!response.ok) {
      console.error("Erro ao consultar pedido no Supabase:", data);
      throw new Error("Não foi possível consultar o pedido.");
    }
    return Array.isArray(data) ? data[0] || null : null;
  }

  async function updateOrder(orderId, changes) {
    const url =
      `${tableUrl}?kiwify_order_id=eq.${encodeURIComponent(orderId)}`;
    const response = await fetch(url, {
      method: "PATCH",
      headers,
      body: JSON.stringify(changes),
    });
    const data = await response.json().catch(() => []);
    if (!response.ok) {
      console.error("Erro ao atualizar pedido no Supabase:", data);
      throw new Error("Não foi possível atualizar o pedido.");
    }
    return data;
  }

  // Compras de produtos adicionais usam uma tabela própria.
  // Não criam outra chave MIV nem disparam uma segunda geração de diagnóstico.
  const additionalPurchasesUrl = `${supabaseUrl}/rest/v1/miv_customer_purchases`;

  async function findAdditionalPurchase(orderId) {
    const response = await fetch(
      additionalPurchasesUrl +
        "?kiwify_order_id=eq." + encodeURIComponent(orderId) +
        "&select=kiwify_order_id,purchase_status&limit=1",
      { headers }
    );
    const data = await response.json().catch(() => []);
    if (!response.ok) {
      console.error("Erro ao consultar compra adicional:", data);
      throw new Error("Não foi possível consultar a compra adicional.");
    }
    return Array.isArray(data) ? data[0] || null : null;
  }

  async function upsertAdditionalPurchase(payload, email, orderId, productId, purchaseStatus = "paid") {
    const existing = await findAdditionalPurchase(orderId);
    // Um reenvio tardio de compra aprovada não pode reativar pedido já reembolsado
    // ou marcado como chargeback.
    if (
      existing &&
      ["refunded", "chargeback"].includes(existing.purchase_status) &&
      purchaseStatus === "paid"
    ) {
      return existing;
    }
    const product = payload.Product || {};
    const commissions = payload.Commissions || {};
    const chargeAmount = Number(commissions.charge_amount);
    const amount = Number.isFinite(chargeAmount) ? Math.round(chargeAmount) / 100 : null;
    const approvedDate = payload.approved_date || payload.created_at || null;
    const purchaseDate = approvedDate && !Number.isNaN(new Date(approvedDate).getTime())
      ? new Date(approvedDate).toISOString()
      : new Date().toISOString();

    const response = await fetch(
      additionalPurchasesUrl + "?on_conflict=kiwify_order_id",
      {
        method: "POST",
        headers: {
          ...headers,
          Prefer: "resolution=merge-duplicates,return=representation",
        },
        body: JSON.stringify({
          buyer_email: email,
          kiwify_order_id: orderId,
          kiwify_product_id: productId,
          product_name: String(product.product_name || "Produto digital").slice(0, 180),
          purchase_status: purchaseStatus,
          amount,
          currency: String(commissions.currency || "").slice(0, 3) || null,
          purchased_at: purchaseDate,
          provider_access_url: /^https:\/\//i.test(String(payload.access_url || "").trim())
            ? String(payload.access_url).trim().slice(0, 2048)
            : null,
          updated_at: new Date().toISOString(),
        }),
      }
    );
    const data = await response.json().catch(() => []);
    if (!response.ok) {
      console.error("Erro ao registrar compra adicional no Supabase:", data);
      throw new Error("Não foi possível registrar a compra adicional.");
    }
    return Array.isArray(data) ? data[0] || null : null;
  }

  async function updateAdditionalPurchase(orderId, status) {
    const response = await fetch(
      additionalPurchasesUrl + "?kiwify_order_id=eq." + encodeURIComponent(orderId),
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({ purchase_status: status, updated_at: new Date().toISOString() }),
      }
    );
    const data = await response.json().catch(() => []);
    if (!response.ok) {
      console.error("Erro ao atualizar compra adicional no Supabase:", data);
      throw new Error("Não foi possível atualizar o acesso do produto.");
    }
    return data;
  }

  async function sendAccessEmail(email, accessKey, firstName) {
    const greetingName = firstName ? ` ${firstName}` : "";
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "MIV | Tri Digital <acesso@mivtridigital.com.br>",
        to: [email],
        subject: "Seu acesso ao MIV está liberado!",
        html: `
          <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#222;line-height:1.6">
            <div style="padding:28px;background:#171717;border-radius:14px 14px 0 0;color:#fff">
              <p style="margin:0;color:#f4b7e8;font-size:12px;letter-spacing:2px">TRI DIGITAL APRESENTA</p>
              <h1 style="margin:8px 0 0;font-size:28px">Seu MIV está liberado!</h1>
            </div>
            <div style="padding:28px;border:1px solid #eee;border-top:0;border-radius:0 0 14px 14px">
              <p>Olá${greetingName}!</p>
              <p>Sua compra foi aprovada e seu acesso ao MIV — Mínimo Instagram Viável já está disponível.</p>
              <p>Use esta chave para entrar na plataforma:</p>
              <div style="padding:18px;text-align:center;background:#f6f3f7;border-radius:10px;font-size:22px;font-weight:bold;letter-spacing:1px">${accessKey}</div>
              <p style="text-align:center;margin:26px 0">
                <a href="https://mivtridigital.com.br" style="display:inline-block;background:#222;color:#fff;text-decoration:none;padding:13px 24px;border-radius:8px;font-weight:bold">ACESSAR MEU MIV</a>
              </p>
              <p>Copie a chave, acesse o site e informe-a na tela inicial para começar seu diagnóstico.</p>
              <p style="font-size:13px;color:#666">Guarde este e-mail. Sua chave é individual e não deve ser compartilhada.</p>
              <p>Com carinho,<br><strong>Equipe Tri Digital</strong></p>
            </div>
          </div>`,
        text:
          `Olá${greetingName}! Sua compra foi aprovada. Sua chave de acesso ao MIV é: ${accessKey}. Acesse https://mivtridigital.com.br e informe sua chave na tela inicial. Equipe Tri Digital.`,
      }),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error("Erro ao enviar e-mail pelo Resend:", data);
      throw new Error("O e-mail de acesso não foi enviado.");
    }
    return data;
  }

  let claimedOrderId = "";
  let providerAcceptedEmail = false;

  try {
    const orderId = String(payload.order_id || "").trim();
    const eventType = String(payload.webhook_event_type || "").toLowerCase();
    const orderStatus = String(payload.order_status || "").toLowerCase();
    const productId = String(payload.Product?.product_id || "").trim();
    const configuredProductId = String(process.env.KIWIFY_PRODUCT_ID || "").trim();

    if (!orderId) {
      // Testes de webhook podem enviar payload demonstrativo sem pedido real.
      return json(res, 200, { ok: true, ignored: true, reason: "Evento sem order_id." });
    }

    let isMivProduct = !configuredProductId || productId === configuredProductId;
    if (productId && (!configuredProductId || productId !== configuredProductId)) {
      // Produtos adicionais precisam ser cadastrados antes da venda. Mantemos
      // o registro do catálogo mesmo depois de despublicar a oferta, para que
      // reembolsos de compras antigas continuem sendo reconhecidos.
      const catalogLookup = await fetch(
        `${supabaseUrl}/rest/v1/miv_products?kiwify_product_id=eq.${encodeURIComponent(productId)}&select=kiwify_product_id&limit=1`,
        { headers }
      );
      const catalogRows = await catalogLookup.json().catch(() => []);
      if (!catalogLookup.ok || !Array.isArray(catalogRows)) {
        console.error("Não foi possível identificar o produto no catálogo MIV:", catalogRows);
        throw new Error("Não foi possível identificar o produto desta compra.");
      }
      const priorAdditionalPurchase = await findAdditionalPurchase(orderId);
      const isKnownAdditionalProduct = catalogRows.length > 0 || Boolean(priorAdditionalPurchase);

      if (configuredProductId) {
        if (!isKnownAdditionalProduct) {
          return json(res, 200, { ok: true, ignored: true, reason: "Produto adicional ainda não cadastrado no catálogo." });
        }
        isMivProduct = false;
      } else {
        // Sem KIWIFY_PRODUCT_ID, preserva o fluxo legado do MIV e separa
        // produtos adicionais somente quando já constam do catálogo/ledger.
        isMivProduct = !isKnownAdditionalProduct;
      }
    }
    const isRefund =
      eventType.includes("refund") ||
      orderStatus.includes("refund") ||
      orderStatus === "refunded";
    const isChargeback =
      eventType.includes("chargeback") ||
      orderStatus.includes("chargeback");
    const approved =
      orderStatus === "paid" ||
      eventType === "order_approved" ||
      eventType === "subscription_renewed";

    const customer = payload.Customer || {};
    const email = normalizeEmail(customer.email);

    // Produtos adicionais são registrados como compras da mesma pessoa (por e-mail).
    // O webhook deve estar inscrito para esses produtos na Kiwify.
    // Se KIWIFY_PRODUCT_ID não estiver configurado, mantém-se o comportamento legado:
    // todos os eventos continuam sendo tratados como a compra principal do MIV.
    if (!isMivProduct) {
      if (!productId) {
        return json(res, 200, { ok: true, ignored: true, reason: "Evento sem identificador de produto." });
      }
      if (isRefund || isChargeback) {
        const refundStatus = isChargeback ? "chargeback" : "refunded";
        if (email && email.includes("@")) {
          await upsertAdditionalPurchase(payload, email, orderId, productId, refundStatus);
        } else {
          await updateAdditionalPurchase(orderId, refundStatus);
        }
        return json(res, 200, { ok: true, purchaseUpdated: true, accessRevoked: true });
      }
      if (!approved) {
        return json(res, 200, { ok: true, ignored: true, reason: "Evento não gera acesso." });
      }
      if (!email || !email.includes("@")) {
        console.error("Compra adicional aprovada sem e-mail de comprador válido.", { orderId, productId });
        return json(res, 422, { ok: false, error: "E-mail do comprador ausente." });
      }

      await upsertAdditionalPurchase(payload, email, orderId, productId);
      return json(res, 200, {
        ok: true,
        purchaseRecorded: true,
        accessLookup: "email",
        productId,
      });
    }

    if (!resendKey) {
      console.error("RESEND_API_KEY não configurada para o fluxo original do MIV.");
      return json(res, 500, { ok: false, error: "Integração de e-mail não configurada." });
    }

    if (isRefund || isChargeback) {
      const existing = await findOrder(orderId);
      if (!existing) {
        return json(res, 200, { ok: true, ignored: true, reason: "Pedido ainda não encontrado." });
      }
      await updateOrder(orderId, {
        status: isChargeback ? "chargeback" : "refunded",
      });
      return json(res, 200, { ok: true, accessRevoked: true });
    }

    if (!approved) {
      return json(res, 200, { ok: true, ignored: true, reason: "Evento não gera acesso." });
    }

    if (!email || !email.includes("@")) {
      console.error("Compra aprovada sem e-mail de comprador válido.", { orderId });
      return json(res, 422, { ok: false, error: "E-mail do comprador ausente." });
    }

    let order = await findOrder(orderId);

    if (!order) {
      const accessKey = makeAccessKey();
      const insertResponse = await fetch(tableUrl, {
        method: "POST",
        headers: {
          ...headers,
          Prefer: "return=representation,resolution=ignore-duplicates",
        },
        body: JSON.stringify({
          access_key: accessKey,
          buyer_email: email,
          kiwify_order_id: orderId,
          status: "available",
        }),
      });
      const inserted = await insertResponse.json().catch(() => []);
      if (!insertResponse.ok) {
        console.error("Erro ao criar chave no Supabase:", inserted);
        throw new Error("Não foi possível criar a chave de acesso.");
      }
      order = Array.isArray(inserted) ? inserted[0] || null : null;
      // Uma repetição concorrente pode ter criado o pedido primeiro.
      if (!order) order = await findOrder(orderId);
    }

    if (!order) throw new Error("Não foi possível recuperar a chave criada.");

    if (order.status === "refunded" || order.status === "chargeback") {
      return json(res, 200, { ok: true, accessRevoked: true });
    }

    if (order.email_sent_at) {
      return json(res, 200, { ok: true, duplicate: true, emailAlreadySent: true });
    }

    // Reserva atomicamente o disparo para evitar e-mails duplicados em reenvios concorrentes.
    // Um bloqueio abandonado pode ser retomado após 15 minutos.
    const now = new Date();
    const staleBefore = new Date(now.getTime() - 15 * 60 * 1000).toISOString();
    const claimUrl =
      `${tableUrl}?kiwify_order_id=eq.${encodeURIComponent(orderId)}` +
      `&email_sent_at=is.null&or=(email_sending_at.is.null,email_sending_at.lt.${encodeURIComponent(staleBefore)})`;
    const claimResponse = await fetch(claimUrl, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ email_sending_at: now.toISOString() }),
    });
    const claimed = await claimResponse.json().catch(() => []);
    if (!claimResponse.ok) {
      console.error("Erro ao reservar envio de e-mail:", claimed);
      throw new Error("Não foi possível reservar o envio do e-mail.");
    }
    if (!Array.isArray(claimed) || claimed.length === 0) {
      const latest = await findOrder(orderId);
      if (latest?.email_sent_at) {
        return json(res, 200, { ok: true, duplicate: true, emailAlreadySent: true });
      }
      return json(res, 503, { ok: false, error: "Envio já está em processamento. Tente novamente." });
    }
    claimedOrderId = orderId;

    // Usa o e-mail gravado no primeiro registro, evitando trocar o destinatário num reenvio.
    await sendAccessEmail(order.buyer_email || email, order.access_key, customer.first_name || customer.full_name);
    providerAcceptedEmail = true;

    const sentAt = new Date().toISOString();
    await updateOrder(orderId, {
      email_sent_at: sentAt,
      email_sending_at: null,
    });

    return json(res, 200, { ok: true, keyCreated: true, emailSent: true });
  } catch (error) {
    console.error("Erro no webhook MIV/Kiwify:", error);
    // Se o provedor ainda não aceitou a mensagem, libera a reserva para nova tentativa.
    // Se aceitou, mantemos o bloqueio temporário para evitar duplicidade até reconciliação.
    if (claimedOrderId && !providerAcceptedEmail) {
      try { await updateOrder(claimedOrderId, { email_sending_at: null }); }
      catch (releaseError) { console.error("Erro ao liberar reserva de e-mail:", releaseError); }
    }
    // Resposta não-2xx para a Kiwify poder reenviar o evento.
    return json(res, 500, { ok: false, error: "Falha no processamento do webhook." });
  }
};


// Vercel: desativa o parser automático para validar a assinatura sobre o corpo bruto.
module.exports.config = {
  api: {
    bodyParser: false,
  },
};
