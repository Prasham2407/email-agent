require("dotenv").config();
const axios = require("axios");

async function testLLM() {
  console.log("🔑 API KEY:", process.env.OPENROUTER_API_KEY);

  try {
    const res = await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        // model: "google/gemma-4-31b-it:free",
        model:"nvidia/nemotron-3-super-120b-a12b:free",
        messages: [
          {
            role: "user",
            content: "Say hello in one line"
          }
        ]
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    console.log("✅ SUCCESS");
    console.log("RESPONSE:", res.data.choices[0].message.content);
  } catch (err) {
    console.error("❌ ERROR:");
    console.error(err.response?.data || err.message);
  }
}

testLLM();