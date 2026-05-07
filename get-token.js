const axios = require("axios");

const code = "4/0AeoWuM95JktjQcRwy_BvvXU1kumkhebJMqlrTPCXoLWkKfzdVMx_7q3eaIXP_BMDfWrvNw";

async function getToken() {
  const res = await axios.post("https://oauth2.googleapis.com/token", {
    code,
    client_id: process.env.CLIENT_ID,
    client_secret: process.env.CLIENT_SECRET,
    redirect_uri: "http://localhost:3000",
    grant_type: "authorization_code",
  });

  console.log(res.data);
}

getToken();