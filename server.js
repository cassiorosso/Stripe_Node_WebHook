const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2025-11-17.clover",
});

const endpointSecret = process.env.STRIPE_SIGNING_SECRET;
const { updateSubscriptionAccount, cancelSubscriptionAccount } = require("./hasura.js");

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function toYyyyMmDdUTC(dateObj) {
  const y = dateObj.getUTCFullYear();
  const m = String(dateObj.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dateObj.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function yesterdayUTC() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d;
}

async function getCustomerEmailFromInvoice(invoice) {
  let email = invoice.customer_email;
  const customerId = invoice.customer;

  if (!email && customerId) {
    const customer = await stripe.customers.retrieve(customerId);
    email = customer?.email;
  }
  return email || null;
}

/* -------------------------------------------------------------------------- */
/* Body parsing (JSON em tudo, EXCETO /webhook)                                */
/* -------------------------------------------------------------------------- */

app.use((req, res, next) => {
  if (req.originalUrl === '/webhook') return next();
  return express.json()(req, res, next);
});

/* -------------------------------------------------------------------------- */
/* CORS                                                                        */
/* -------------------------------------------------------------------------- */

app.use((req, res, next) => {
  if (req.originalUrl === '/webhook') return next();

  const allowedOrigins = [
    'https://performancenosestudosapp-production.up.railway.app',
    'https://performancenosestudos.com.br',
    'https://www.performancenosestudos.com.br'
  ];

  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }

  res.header("Access-Control-Allow-Methods", "GET,PUT,PATCH,POST,DELETE,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");

  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

/* -------------------------------------------------------------------------- */

app.get('/', (req, res) => res.send("Stripe Webhook API is up - 2025-11-17.clover"));

/* -------------------------------------------------------------------------- */
/* Webhook                                                                     */
/* -------------------------------------------------------------------------- */

app.post(
  '/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig = req.headers['stripe-signature'];

    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    } catch (err) {
      console.error('Webhook signature error:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
      switch (event.type) {

        /* ---------------- Ativação da assinatura ---------------- */
        case 'invoice.payment_succeeded': {
          const invoice = event.data.object;

          // Só processa a 1ª cobrança da assinatura
          if (invoice.billing_reason !== 'subscription_create') break;

          const subscriptionId = invoice.subscription;
          if (!subscriptionId) {
            console.log('invoice.payment_succeeded sem subscriptionId. invoice:', invoice.id);
            break;
          }

          // Pegue o line item (o seu payload mostra que period.end existe aqui)
          const lineItem = invoice.lines?.data?.[0];
          const priceId = lineItem?.price?.id;

          // (opcional) validar priceId se quiser
          const PRICE_TO_MONTHS = {
            [process.env.PRICE_MENSAL]: 1,
            [process.env.PRICE_SEMESTRAL]: 6,
            [process.env.PRICE_ANUAL]: 12,
          };

          if (priceId && !PRICE_TO_MONTHS[priceId]) {
            console.log('PriceId não mapeado:', priceId, 'invoice:', invoice.id);
            // break; // se quiser bloquear planos desconhecidos
          }

          // Email robusto
          const customerEmail = await getCustomerEmailFromInvoice(invoice);
          if (!customerEmail) {
            console.log('Não consegui identificar email do customer. invoice:', invoice.id);
            break;
          }

          // ✅ AQUI está o ponto-chave: use o period.end da invoice
          const periodEnd = lineItem?.period?.end;

          if (!periodEnd || typeof periodEnd !== 'number') {
            console.log('invoice lineItem.period.end inválido:', periodEnd, 'invoice:', invoice.id);
            break;
          }

          // Configura para cancelar no final do período
          await stripe.subscriptions.update(subscriptionId, {
            cancel_at_period_end: true,
          });

          const expirationDate = new Date(periodEnd * 1000);
          const subscriptionDate = toYyyyMmDdUTC(expirationDate);

          if (!subscriptionDate) {
            console.log('subscriptionDate inválida. expirationDate:', expirationDate, 'periodEnd:', periodEnd);
            break;
          }

          await updateSubscriptionAccount({
            email: customerEmail,
            subscription_date: subscriptionDate,
            subscription_id: subscriptionId
          });

          console.log(`✅ Assinatura ${subscriptionId} expira em ${subscriptionDate} (UTC)`);
          break;
        }

        case 'customer.subscription.updated': {
          const sub = event.data.object;

          if (sub.status === 'canceled' || sub.status === 'unpaid') {
            await cancelSubscriptionAccount({
              subscription_id: sub.id,
              subscription_date: toYyyyMmDdUTC(yesterdayUTC()),
            });
          }

          break;
        }



        /* ---------------- Falha de pagamento ---------------- */
        case 'invoice.payment_failed': {
          const invoice = event.data.object;
          const customerEmail = await getCustomerEmailFromInvoice(invoice);
          if (!customerEmail) break;

          await updateSubscriptionAccount({
            email: customerEmail,
            subscription_date: toYyyyMmDdUTC(yesterdayUTC()),
            subscription_id: invoice.subscription || ""
          });

          break;
        }

        /* ---------------- Falha ao finalizar invoice ---------------- */
        case 'invoice.finalization_failed': {
          const invoice = event.data.object;
          const customerEmail = await getCustomerEmailFromInvoice(invoice);
          if (!customerEmail) break;

          await updateSubscriptionAccount({
            email: customerEmail,
            subscription_date: toYyyyMmDdUTC(yesterdayUTC()),
            subscription_id: invoice.subscription || ""
          });

          break;
        }

        /* ---------------- Cancelamento da assinatura ---------------- */
        case 'customer.subscription.deleted': {
          const subscriptionId = event.data.object.id;

          await cancelSubscriptionAccount({
            subscription_id: subscriptionId,
            subscription_date: toYyyyMmDdUTC(yesterdayUTC())
          });

          break;
        }

        default:
          console.log(`Unhandled event type ${event.type}`);
      }

      return res.json({ received: true });
    } catch (err) {
      console.error('Webhook handler error:', err);
      return res.status(500).json({ error: 'Webhook handler failed' });
    }
  }
);

/* -------------------------------------------------------------------------- */

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}/`);
});
