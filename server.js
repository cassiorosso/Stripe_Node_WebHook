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

          // Só no primeiro pagamento da assinatura
          if (invoice.billing_reason !== 'subscription_create') break;

          const subscriptionId = invoice.subscription;
          const line = invoice.lines?.data?.find(l => l.price?.recurring) || invoice.lines?.data?.[0];
          const priceId = line?.price?.id;

          if (!priceId || !subscriptionId) break;

          const PRICE_TO_MONTHS = {
            [process.env.PRICE_MENSAL]: 1,
            [process.env.PRICE_SEMESTRAL]: 6,
            [process.env.PRICE_ANUAL]: 12,
          };

          const monthsToAdd = PRICE_TO_MONTHS[priceId];
          if (!monthsToAdd) break;

          const customerEmail = await getCustomerEmailFromInvoice(invoice);
          if (!customerEmail) break;

          const paidAt = invoice.status_transitions?.paid_at;
          const startDate = paidAt ? new Date(paidAt * 1000) : new Date();

          const endDate = new Date(startDate);
          endDate.setUTCMonth(endDate.getUTCMonth() + monthsToAdd);

          const cancelAt = Math.floor(endDate.getTime() / 1000);
          await stripe.subscriptions.update(subscriptionId, {
            cancel_at: cancelAt,
            cancel_at_period_end: false,
          });

          await updateSubscriptionAccount({
            email: customerEmail,
            subscription_date: toYyyyMmDdUTC(endDate),
            subscription_id: subscriptionId
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
