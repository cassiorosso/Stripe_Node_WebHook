// importando os pacotes para uso no arquivo index.js
const express = require('express');

// crio um servidor express
const app = express();
const dotenv = require('dotenv');

dotenv.config();

const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2024-06-20",
});
const endpointSecret = process.env.STRIPE_SIGNING_SECRET

const { updateSubscriptionAccount } = require("./hasura.js");

app.use((request, response, next) => {
  if (request.originalUrl === '/webhook') {
    next();
  } else {
    express.json()(request, response, next);
  }
});

app.get('/', (req, res) => res.send("Stripe Webhook API is up!"));

app.post(
  '/webhook',
  // Stripe requires the raw body to construct the event
  express.raw({type: 'application/json'}),
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
    case 'payment_intent.succeeded':
      const paymentIntent = event.data.object;
      // Then define and call a method to handle the successful payment intent.
      // handlePaymentIntentSucceeded(paymentIntent);
      response.send({ id: paymentIntent.id, email: paymentIntent.receipt_email });
        const todayDate = new Date();
        const day = todayDate.getDate();
        const month = todayDate.getMonth() + 2; // Add 1 as months are zero-based
        const year = todayDate.getFullYear();
        const subscriptionDate = `${year}-${month}-${day}`;
      
      await updateSubscriptionAccount({
        email: "cassiorosso@hotmail.com",
        subscription_date: subscriptionDate
      });
      break;
    case 'payment_method.attached':
      const paymentMethod = event.data.object;
      // Then define and call a method to handle the successful attachment of a PaymentMethod.
      // handlePaymentMethodAttached(paymentMethod);
      break;
    // ... handle other event types
    default:
      console.log(`Unhandled event type ${event.type}`);
  }

  // Return a response to acknowledge receipt of the event
  response.json({received: true});
});


  // o servidor irá rodar dentro da porta 9000
app.listen(process.env.PORT, () => console.log('API is up!'));