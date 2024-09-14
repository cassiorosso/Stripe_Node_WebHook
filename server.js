const express = require('express');
const app = express();
const PORT = 3000;
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2024-06-20",
});
const endpointSecret = process.env.STRIPE_SIGNING_SECRET
const { updateSubscriptionAccount } = require("./hasura.js");
const { cancelSubscriptionAccount } = require("./hasura.js");

app.use((request, response, next) => {
  if (request.originalUrl === '/webhook') {
    next();
  } else {
    express.json()(request, response, next);
  }
});

app.get('/', (req, res) => res.send("Stripe Webhook API is up!"));

app.post('/cancel', async (req, res) => {
  //const subscription = await stripe.subscriptions.cancel('{{SUBSCRIPTION_ID}}');
  res.send(req.body.subscription_id);
}
);

app.post(
  '/webhook',
  // Stripe requires the raw body to construct the event
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
        const customerSubscription = event.data.object.subscription
        const todayDate = new Date();
        const day = todayDate.getDate();
        const month = todayDate.getMonth() + 2; // Add 1 as months are zero-based
        const year = todayDate.getFullYear();
        const subscriptionDate = `${year}-${month}-${day}`;

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
