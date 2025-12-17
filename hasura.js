const axios = require("axios");
const hasuraAdminSecret = process.env.HASURA_ADMIN_SECRET;
const hasuraProjectUrl = process.env.HASURA_PROJECT;

const hasuraGql = async (query, queryVariables) => {
  const { data } = await axios({
    url: hasuraProjectUrl,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-hasura-admin-secret": hasuraAdminSecret
    },
    data: { query, variables: queryVariables }
  });

  if (data.errors) {
    throw new Error(data.errors[0].message);
  }
  return data;
};

const UPDATE_SUBSCRIPTION_ACCOUNT = `
mutation UpdateSubscriptionUser(
  $email: String!,
  $subscription_date: date!,
  $subscription_id: String!
) {
  update_users(
    where: { email: { _eq: $email } },
    _set: {
      subscription_date: $subscription_date,
      subscription_id: $subscription_id
    }
  ) {
    affected_rows
  }
}
`;

const CANCEL_SUBSCRIPTION_ACCOUNT = `
mutation CancelSubscriptionUser(
  $subscription_id: String!,
  $subscription_date: date!
) {
  update_users(
    where: { subscription_id: { _eq: $subscription_id } },
    _set: { subscription_id: "", subscription_date: $subscription_date }
  ) {
    affected_rows
  }
}
`;

const updateSubscriptionAccount = async (accountInfo) => {
  return await hasuraGql(UPDATE_SUBSCRIPTION_ACCOUNT, accountInfo);
};

const cancelSubscriptionAccount = async (accountInfo) => {
  return await hasuraGql(CANCEL_SUBSCRIPTION_ACCOUNT, accountInfo);
};

module.exports = { updateSubscriptionAccount, cancelSubscriptionAccount };
