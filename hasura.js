const axios = require("axios");
const hasuraAdminSecret = process.env.HASURA_ADMIN_SECRET;
const hasuraProjectUrl = process.env.HASURA_PROJECT;

const hasuraGql = async (query, queryVariables) =>{
  const { data } = await axios({
    url: hasuraProjectUrl,
    method: "POST",
    headers:{
      "Content-Type": "application/json",
      "x-hasura-admin-secret": hasuraAdminSecret
    },
    data: {
      query: query,
      variables: queryVariables
    }
  });
  
  if(data.errors){
    const error = data.errors[0];
    throw new Error(error.message)
  }
  
  return data;
}

const UPDATE_SUBSCRIPTION_ACCOUNT = 
`
mutation UpdateSubscriptionUser(
  $email: String!,
  $subscription_date: date!) {
  update_users(where: {email: {_eq: $email}}, _set: {subscription_date: $subscription_date}) {
    affected_rows
  }
}
`

const updateSubscriptionAccount = async (accountInfo) => {
  return await hasuraGql(UPDATE_SUBSCRIPTION_ACCOUNT, accountInfo);
}

module.exports = { updateSubscriptionAccount };