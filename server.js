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

app.get('/', (req, res) => res.send("Stripe Webhook API is up!"));

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

          // 1. Evite processar invoices que não são de assinaturas (ex: vendas avulsas)
          if (!invoice.subscription) break;

          // 2. Pegar os metadados ou linhas de forma segura
          const subscription = await stripe.subscriptions.retrieve(invoice.subscription);
          const priceId = subscription.items.data[0].price.id;

          const PRICE_TO_MONTHS = {
            [process.env.PRICE_MENSAL]: 1,
            [process.env.PRICE_SEMESTRAL]: 6,
            [process.env.PRICE_ANUAL]: 12,
          };

          const monthsToAdd = PRICE_TO_MONTHS[priceId];
          if (!monthsToAdd) {
            console.error(`PriceId ${priceId} não mapeado no PRICE_TO_MONTHS`);
            break;
          }

          // 3. Email do cliente (Priorize o email do cliente do Stripe)
          const customerEmail = invoice.customer_email || (await stripe.customers.retrieve(invoice.customer)).email;

          // 4. Calcular o término baseado no período atual do Stripe
          // O Stripe trabalha com timestamps (segundos). 
          // subscription.current_period_end já é o fim do ciclo pago.
          const endDateUnix = subscription.current_period_end;
          const endDateJS = new Date(endDateUnix * 1000);

          // 5. Se você quer que a assinatura NÃO renove automaticamente:
          // Em vez de calcular cancel_at, você pode simplesmente usar:
          await stripe.subscriptions.update(invoice.subscription, {
            cancel_at_period_end: true,
          });

          // 6. Atualizar seu banco de dados
          await updateSubscriptionAccount({
            email: customerEmail,
            subscription_date: toYyyyMmDdUTC(endDateJS),
            subscription_id: invoice.subscription
          });

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
