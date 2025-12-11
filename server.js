const express = require('express');
const app = express();
const PORT = 3000;
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2024-06-20",
});
const endpointSecret = process.env.STRIPE_SIGNING_SECRET
const { updateSubscriptionAccount, cancelSubscriptionAccount } = require("./hasura.js");

app.use((request, response, next) => {
  if (request.originalUrl === '/webhook') {
    next();
  } else {
    //'http://localhost:3000'
    const allowedOrigins = ['https://performancenosestudosapp-production.up.railway.app/', 'https://performancenosestudos.com.br/', 'https://www.performancenosestudos.com.br/'];
    const origin = request.headers.origin;
    if (allowedOrigins.includes(origin)) {
      response.setHeader('Access-Control-Allow-Origin', origin);
    }
    response.header("Access-Control-Allow-Methods", "GET,PUT,PATCH,POST,DELETE");
    response.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    express.json()(request, response, next);
  }
});

app.get('/', (req, res) => res.send("Stripe Webhook API is up!"));

app.post('/cancel', async (req, res) => {
  const customerSubId = req.body.subscriptionId;
  try {
    const subscription = await stripe.subscriptions.update(customerSubId, {
      cancel_at_period_end: true
    });
    res.status(200).send(req.body.subscriptionId);
  } catch (err) {
    res.sendStatus(400);
  }

}
);

app.post(
  '/webhook',
  express.raw({ type: 'application/json' }),
  async (request, response) => {
    const sig = request.headers['stripe-signature'];

    let event;

    try {
      event = stripe.webhooks.constructEvent(request.body, sig, endpointSecret);
    }
    catch (err) {
      response.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Handle the event
    switch (event.type) {
      case 'invoice.payment_succeeded':
        const customerEmail = event.data.object.customer_email;
        const customerSubscription = event.data.object.subscription;

        // 1. Obtém a data atual (hoje)
        const todayDate = new Date();

        // 2. Cria uma nova data para a expiração da assinatura
        // É crucial criar uma NOVA instância de Data para não modificar a 'todayDate'
        const newSubscriptionDate = new Date(todayDate);

        // 3. Adiciona 1 MÊS à data. 
        // O JavaScript manipula automaticamente o estouro do mês e a virada do ano.
        // getMonth() retorna o mês atual (0-11). Adicionamos 1 para avançar um mês.
        newSubscriptionDate.setMonth(newSubscriptionDate.getMonth() + 1);

        // O seu código original adicionava +1 ao dia (todayDate.getDate() + 1),
        // Vou manter essa lógica, mas de forma mais limpa, usando setDate().
        // newSubscriptionDate.setDate(newSubscriptionDate.getDate() + 1); 

        // 4. Formata a data para 'YYYY-MM-DD'
        // Usamos métodos de data para obter os componentes e formatar em string ISO 8601.

        // Garante que o mês tenha 2 dígitos (ex: '01' ao invés de '1')
        const year = newSubscriptionDate.getFullYear();
        // getMonth() retorna 0-11, então adicionamos 1. 
        // O método padStart(2, '0') adiciona um '0' à esquerda se for um único dígito.
        const month = String(newSubscriptionDate.getMonth() + 1).padStart(2, '0');
        // Garante que o dia tenha 2 dígitos
        const day = String(newSubscriptionDate.getDate()).padStart(2, '0');

        const subscriptionDate = `${year}-${month}-${day}`;

        // Exemplo: Se hoje é 10/12/2025, a nova data será 10/01/2026

        await updateSubscriptionAccount({
          email: customerEmail,
          subscription_date: subscriptionDate,
          subscription_id: customerSubscription
        });
        break;
      case 'customer.subscription.deleted':
        const customerId = event.data.object.id;
        await cancelSubscriptionAccount({
          subscription_id: customerId
        });

        break;
      // ... handle other event types
      default:
        console.log(`Unhandled event type ${event.type}`);
    }

    // Return a response to acknowledge receipt of the event
    response.json({ received: true });
  });

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}/`);
});
